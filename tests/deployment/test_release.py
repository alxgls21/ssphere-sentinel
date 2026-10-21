"""Releases (.github/workflows/release.yml): the version a tag may name, the bundle a server installs from, and
the order in which nothing is published before it has been tested."""

from __future__ import annotations

import hashlib
import importlib.util
import re
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("release_bundle", ROOT / ".github" / "scripts" / "release_bundle.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)

VERSION = release.declared_versions()["pyproject.toml"]
SERVER = "ghcr.io/alxgls21/ssphere-sentinel@sha256:" + "a" * 64
PROXY = "ghcr.io/alxgls21/ssphere-sentinel-proxy@sha256:" + "b" * 64
PINNED = re.compile(r"^[\w.-]+/[\w.-]+@[0-9a-f]{40}$")


def load_yaml(test: unittest.TestCase, text: str):
    try:
        import yaml
    except ImportError:  # pragma: no cover - CI installs PyYAML
        test.skipTest("PyYAML is not installed")
    return yaml.safe_load(text)


class VersionTests(unittest.TestCase):
    def test_the_server_and_the_agent_declare_one_version(self):
        self.assertEqual(len(set(release.declared_versions().values())), 1)

    def test_a_tag_names_the_declared_version(self):
        self.assertEqual(release.version_of(f"v{VERSION}"),
                         {"version": VERSION, "minor": VERSION.rsplit(".", 1)[0], "stable": "true"})
        self.assertEqual(release.version_of(f"v{VERSION}-rc.2")["version"], f"{VERSION}-rc.2")
        self.assertEqual(release.version_of(f"v{VERSION}-rc.2")["stable"], "false")

    def test_anything_else_is_refused(self):
        major, minor, patch = (int(part) for part in VERSION.split("."))
        for tag in (VERSION, f"v{major}.{minor}.{patch + 1}", f"v{VERSION}-rc.0", f"v{VERSION}-beta",
                    f"v{VERSION}.1", f"v0{VERSION}", f"v{VERSION}\n", "latest", ""):
            with self.subTest(tag=tag):
                with self.assertRaises(release.ReleaseError):
                    release.version_of(tag)


class BundleTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.out = Path(directory.name)
        self.archive = release.bundle(VERSION, SERVER, PROXY, self.out)
        with tarfile.open(self.archive) as tar:
            self.members = {member.name: member for member in tar.getmembers()}
            self.files = {name: tar.extractfile(member).read() for name, member in self.members.items()}
        self.compose_text = self.files[f"sentinel-{VERSION}/compose.yml"].decode()

    def test_it_holds_what_a_server_needs_and_nothing_of_the_installation(self):
        prefix = f"sentinel-{VERSION}/"
        self.assertEqual(set(self.members), {prefix + name for name in release.FILES})
        for name in self.members:
            self.assertNotRegex(name, r"(^|/)\.env($|\.(?!example$))")  # no .env, .env.tunnel, ...
        self.assertEqual(self.members[prefix + "scripts/postgres-preflight.sh"].mode, 0o755)
        self.assertEqual(self.members[prefix + "compose.yml"].mode, 0o644)
        for name, data in self.files.items():
            if not name.endswith("compose.yml"):
                self.assertEqual(data, (ROOT / name.removeprefix(prefix)).read_bytes(), name)

    def test_every_file_the_compose_files_name_is_in_it(self):
        prefix = f"sentinel-{VERSION}/"
        named = set(re.findall(r"(deploy/[\w./-]+\.(?:yml|env))", self.compose_text))
        named |= {path.replace("${SENTINEL_POSTGRES:-16}", major) for path in named for major in ("16", "18")}
        named = {path for path in named if "$" not in path}
        self.assertTrue(named)
        for path in named:
            self.assertIn(prefix + path, self.members)

    def test_the_images_are_named_by_digest_and_nothing_is_built(self):
        compose = load_yaml(self, self.compose_text)
        for name, service in compose["services"].items():
            with self.subTest(service=name):
                self.assertNotIn("build", service)
                self.assertEqual(service["image"], PROXY if name == "proxy" else SERVER)
        # Apart from the builds, the release's compose.yml is the repository's.
        source = (ROOT / "compose.yml").read_text()
        repository = load_yaml(self, source)
        for name, service in compose["services"].items():
            expected = {key: value for key, value in repository["services"][name].items() if key != "build"}
            self.assertEqual({key: value for key, value in service.items() if key != "image"}, expected, name)
        self.assertEqual({key: value for key, value in compose.items() if key != "services"},
                         {key: value for key, value in repository.items() if key != "services"})

    def test_the_checksum_is_the_archive_s(self):
        digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.assertEqual((self.out / "SHA256SUMS").read_text(), f"{digest}  {self.archive.name}\n")

    def test_the_same_inputs_make_the_same_archive(self):
        again = release.bundle(VERSION, SERVER, PROXY, self.out / "again")
        self.assertEqual(again.read_bytes(), self.archive.read_bytes())

    def test_images_that_are_not_pinned_or_not_ghcr_are_refused(self):
        for server in ("ghcr.io/alxgls21/ssphere-sentinel:0.1.0", "docker.io/alxgls21/ssphere-sentinel@sha256:" + "a" * 64,
                       "ghcr.io/alxgls21/ssphere-sentinel@sha256:" + "a" * 63):
            with self.subTest(server=server):
                with self.assertRaises(release.ReleaseError):
                    release.bundle(VERSION, server, PROXY, self.out / "refused")

    def test_a_compose_file_whose_builds_changed_is_refused(self):
        source = (ROOT / "compose.yml").read_text()
        for changed in (source.replace("    build: .\n", "    build:\n      context: .\n", 1),
                        source.replace("        nginx: ./deploy/frontend\n", "        nginx: ./elsewhere\n")):
            with self.subTest():
                with self.assertRaises(release.ReleaseError):
                    release.release_compose(changed, VERSION, SERVER, PROXY)


class ReleaseWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.text = (ROOT / ".github" / "workflows" / "release.yml").read_text()
        self.workflow = load_yaml(self, self.text)
        self.jobs = self.workflow["jobs"]

    def test_only_a_tag_starts_a_release(self):
        # PyYAML reads the key "on" as True.
        self.assertEqual(self.workflow[True], {"push": {"tags": ["v*"]}})
        self.assertEqual(self.workflow["permissions"], {"contents": "read"})
        self.assertIs(self.workflow["concurrency"]["cancel-in-progress"], False)

    def test_nothing_is_published_before_everything_before_it_passed(self):
        needs = {name: set([job["needs"]] if isinstance(job.get("needs"), str) else job.get("needs", []))
                 for name, job in self.jobs.items()}
        self.assertEqual(needs, {
            "verify": set(),
            "ci": {"verify"},
            "images": {"verify", "ci"},
            "bundle": {"verify", "images"},
            "publish": {"verify", "images", "bundle"},
        })
        for job in self.jobs.values():
            self.assertNotIn("if", job)
            self.assertNotIn("continue-on-error", job)

    def test_ci_runs_in_full_on_the_tagged_commit(self):
        self.assertEqual(self.jobs["ci"]["uses"], "./.github/workflows/ci.yml")
        ci = load_yaml(self, (ROOT / ".github" / "workflows" / "ci.yml").read_text())
        self.assertIn("workflow_call", ci[True])
        self.assertNotIn("inputs", ci[True]["workflow_call"] or {})

    def test_each_job_may_do_only_its_own_part(self):
        expected = {
            "ci": {"contents": "read"},
            "images": {"contents": "read", "packages": "write", "id-token": "write", "attestations": "write"},
            "bundle": {"contents": "read", "packages": "read"},
            "publish": {"contents": "write", "packages": "write"},
        }
        for name, permissions in expected.items():
            self.assertEqual(self.jobs[name]["permissions"], permissions, name)
        self.assertNotIn("permissions", self.jobs["verify"])

    def test_actions_are_pinned_and_the_checkouts_keep_no_credentials(self):
        for name, job in self.jobs.items():
            for step in job.get("steps", []):
                if "uses" in step:
                    with self.subTest(job=name, step=step["uses"]):
                        self.assertRegex(step["uses"], PINNED)
                        self.assertTrue(step["uses"].startswith("actions/"))
                        if step["uses"].startswith("actions/checkout@"):
                            self.assertIs(step["with"]["persist-credentials"], False)

    def test_the_tag_is_checked_and_on_main(self):
        runs = " ".join(step.get("run", "") for step in self.jobs["verify"]["steps"])
        self.assertIn('release_bundle.py version "$GITHUB_REF_NAME"', runs)
        self.assertIn('git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main', runs)
        self.assertNotIn("| tee", runs)  # a pipe would hide the check's failure

    def test_the_bundle_is_installed_without_the_repository_and_without_a_build(self):
        steps = self.jobs["bundle"]["steps"]
        runs = "\n".join(step.get("run", "") for step in steps)
        self.assertIn("sha256sum --check SHA256SUMS", runs)
        self.assertIn("docker compose up --detach --no-build --wait", runs)
        self.assertIn("check-server.sh", runs)
        for step in steps:
            if "docker compose" in step.get("run", "") or "check-server" in step.get("run", ""):
                self.assertEqual(step.get("working-directory"), "${{ runner.temp }}/install", step["name"])

    def test_the_moving_tags_follow_a_stable_release_only(self):
        steps = {step["name"]: step for step in self.jobs["publish"]["steps"]}
        moving = steps["The X.Y and latest tags of a stable release"]
        self.assertEqual(moving["if"], "needs.verify.outputs.stable == 'true'")
        self.assertIn('--tag "$name:latest"', moving["run"])
        release_run = steps["The release"]["run"]
        self.assertIn("--verify-tag", release_run)
        self.assertIn("sha256sum --check SHA256SUMS", release_run)
        self.assertIn("--prerelease", release_run)
        # Images are pushed with the release's version only; the moving tags wait for the tested bundle.
        script = (ROOT / ".github" / "scripts" / "release-image.sh").read_text()
        self.assertEqual(re.findall(r'--tag "([^"]+)"', script), ["$name:$VERSION"])
        self.assertIn("--provenance mode=max", script)
        self.assertIn("--sbom true", script)

    def test_the_registry_token_never_reaches_a_command_line(self):
        self.assertNotRegex(self.text, r"docker login[^\n]*\$\{\{")
        self.assertNotRegex(self.text, r"--password[ =]")
        for match in re.finditer(r"docker login[^\n]*", self.text):
            self.assertIn("--password-stdin", match[0])


if __name__ == "__main__":
    unittest.main()
