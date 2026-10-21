"""The installation bundle of a release, and the check of its version (.github/workflows/release.yml).

    release_bundle.py version <tag>
        The version a tag names (vX.Y.Z, or vX.Y.Z-rc.N for a pre-release), checked against the versions the
        server and the agent declare; prints version=, minor= and stable= for $GITHUB_OUTPUT.

    release_bundle.py bundle --version <version> --server <image@digest> --proxy <image@digest> --out <directory>
        sentinel-<version>.tar.gz and SHA256SUMS in <directory>: what a server needs to run the release without
        a checkout or a build. compose.yml names the images by digest, so it runs exactly what was tested.

Standard library only: it runs on a bare runner.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import re
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TAG = re.compile(r"^v(?P<version>(?P<minor>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.(?:0|[1-9]\d*))(?P<rc>-rc\.[1-9]\d*)?$")
IMAGE = re.compile(r"^ghcr\.io/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$")

# What a server needs: the Compose files, the files they name, the preflight the guide runs before every start,
# the settings template and the licence. (scripts/postgres-roles.sh, for the separate database logins, runs
# Python of the repository on the host: those still need a checkout.)
FILES = (
    "compose.yml",
    "compose.tunnel.yml",
    "deploy/postgres/postgres-16.yml",
    "deploy/postgres/postgres-18.yml",
    "deploy/compose/no-bootstrap-secrets.env",
    "deploy/compose/no-migration-secrets.env",
    "scripts/postgres-preflight.sh",
    ".env.example",
    "LICENSE",
)
EXECUTABLE = {"scripts/postgres-preflight.sh"}

# The builds of compose.yml, each replaced by its image: the server image's (every service but the proxy) and
# the proxy's.
SERVER_BUILD = re.compile(r"^(?P<indent> +)build: \.\n", re.MULTILINE)
PROXY_BUILD = re.compile(
    r"^(?P<indent> +)build:\n"
    r"(?P=indent)  context: \./frontend\n"
    r"(?P=indent)  dockerfile: \.\./deploy/frontend/Dockerfile\n"
    r"(?P=indent)  additional_contexts:\n"
    r"(?P=indent)    nginx: \./deploy/frontend\n",
    re.MULTILINE,
)
SERVER_SERVICES = 5  # migrate, web, alert-engine, notifier, domain-verifier


class ReleaseError(Exception):
    pass


def declared_versions() -> dict[str, str]:
    server = re.search(r'(?m)^version = "([^"]+)"$', (ROOT / "pyproject.toml").read_text())
    agent = re.search(r'(?m)^__version__ = "([^"]+)"$', (ROOT / "agent" / "__init__.py").read_text())
    if not server or not agent:
        raise ReleaseError("cannot read the versions of pyproject.toml and agent/__init__.py")
    return {"pyproject.toml": server[1], "agent/__init__.py": agent[1]}


def version_of(tag: str) -> dict[str, str]:
    match = TAG.fullmatch(tag)
    if not match:
        raise ReleaseError(f"{tag!r} is not a release tag: vX.Y.Z, or vX.Y.Z-rc.N for a pre-release")
    for path, declared in declared_versions().items():
        if declared != match["version"]:
            raise ReleaseError(f"the tag is {tag}, but {path} declares version {declared}")
    return {
        "version": match["version"] + (match["rc"] or ""),
        "minor": match["minor"],
        "stable": "false" if match["rc"] else "true",
    }


def release_compose(text: str, version: str, server: str, proxy: str) -> str:
    """compose.yml with its builds replaced by the release's images."""
    for image in (server, proxy):
        if not IMAGE.fullmatch(image):
            raise ReleaseError(f"{image!r} is not an image of ghcr.io named by its digest")
    text, proxies = PROXY_BUILD.subn(lambda match: f"{match['indent']}image: {proxy}\n", text)
    text, servers = SERVER_BUILD.subn(lambda match: f"{match['indent']}image: {server}\n", text)
    if (proxies, servers) != (1, SERVER_SERVICES):
        raise ReleaseError(f"compose.yml has {proxies} proxy and {servers} server build(s), "
                           f"not 1 and {SERVER_SERVICES}: update release_bundle.py with it")
    if re.search(r"(?m)^\s+build:", text):
        raise ReleaseError("compose.yml still builds an image")
    note = (f"# SSphere Sentinel {version}: the images are named by their digest, nothing is built here.\n"
            "# Update to another release with its bundle, then: docker compose pull && docker compose up -d\n#\n")
    return note + text


def bundle(version: str, server: str, proxy: str, out: Path) -> Path:
    if not re.fullmatch(r"\d+\.\d+\.\d+(-rc\.\d+)?", version):
        raise ReleaseError(f"{version!r} is not a release version")
    prefix = f"sentinel-{version}"
    out.mkdir(parents=True, exist_ok=True)
    archive = out / f"{prefix}.tar.gz"
    with tarfile.open(archive, "w:gz", format=tarfile.PAX_FORMAT) as tar:
        for name in FILES:
            data = (ROOT / name).read_bytes()
            if name == "compose.yml":
                data = release_compose(data.decode(), version, server, proxy).encode()
            info = tarfile.TarInfo(f"{prefix}/{name}")
            info.size = len(data)
            info.mode = 0o755 if name in EXECUTABLE else 0o644
            info.mtime = 0
            info.uname = info.gname = "root"
            tar.addfile(info, io.BytesIO(data))
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (out / "SHA256SUMS").write_text(f"{digest}  {archive.name}\n")
    return archive


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("version").add_argument("tag")
    make = commands.add_parser("bundle")
    make.add_argument("--version", required=True)
    make.add_argument("--server", required=True)
    make.add_argument("--proxy", required=True)
    make.add_argument("--out", required=True, type=Path)
    arguments = parser.parse_args(argv)
    try:
        if arguments.command == "version":
            for key, value in version_of(arguments.tag).items():
                print(f"{key}={value}")
        else:
            print(bundle(arguments.version, arguments.server, arguments.proxy, arguments.out))
    except ReleaseError as error:
        print(f"release: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
