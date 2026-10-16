"""Judge a run of the PostgreSQL-backed tests (postgres-tests.sh) and report it.

The run passes only if every module named ran tests, and every test passed:
none skipped, none failed, none errored, no module that could not be loaded
and no class whose setUpClass failed, and Django's own test database was never
created (none of these tests uses it). It prints, and adds to the job's
summary on GitHub Actions, the server's version and the count of each module.
Standard library only.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter

# Django's runner at verbosity 2: "test_name (package.module.Class.test_name) ... ok", or, for a
# test with a docstring, that name alone and the docstring's first line ending in "... ok".
TEST = r"(?P<test>\w+) \((?P<module>[\w.]+)\.(?P<cls>\w+)\.(?P=test)\)"
RESULT = re.compile(rf"^{TEST} \.\.\. (?P<outcome>.*)$")
# A subtest that did not pass, indented under its test, whose own line then ends at "... ".
SUBTEST = re.compile(rf"^  {TEST} \(.*\) \.\.\. (?P<outcome>.*)$")
NAME = re.compile(rf"^{TEST}$")
DESCRIBED = re.compile(r"^.* \.\.\. (?P<outcome>ok|FAIL|ERROR|skipped .*|expected failure|unexpected success)$")
RAN = re.compile(r"^Ran (\d+) tests? in ")
# What unittest prints after "... ". Anything else is other output (a child process's stderr)
# printed into the line: the run fails, saying so.
OUTCOMES = ("ok", "FAIL", "ERROR", "skipped", "expected failure", "unexpected success")
INTERLEAVED = "result line(s) cut by other output"


def judge(log: str, modules: list[str]) -> tuple[list[str], dict[str, Counter], int]:
    """What is wrong with the run (empty: it passed), the outcomes per module, and the tests run."""
    problems = []
    outcomes: dict[str, Counter] = {module: Counter() for module in modules}
    lines = log.splitlines()
    for index, line in enumerate(lines):
        following = lines[index + 1] if index + 1 < len(lines) else ""
        match = RESULT.match(line) or SUBTEST.match(line)
        if not match and (named := NAME.match(line)) and following:
            described = DESCRIBED.match(following)
            match = described and {"module": named["module"], "outcome": described["outcome"]}
        if match and not match["outcome"] and SUBTEST.match(following):
            continue  # counted by its subtests
        if match:
            outcome = next((name for name in OUTCOMES if match["outcome"] == name or match["outcome"].startswith(name + " ")),
                           INTERLEAVED)
            outcomes.setdefault(match["module"], Counter())[outcome] += 1
    ran = [int(match[1]) for line in lines if (match := RAN.match(line))]
    if len(ran) != 1:
        problems.append(f"the run reported {len(ran)} totals, not one ('Ran N tests')")
    total = ran[-1] if ran else 0
    summary = [line for line in lines if line.startswith(("OK", "FAILED"))]
    if summary[-1:] != ["OK"]:
        problems.append(f"the run did not end with a plain OK: {summary[-1] if summary else 'no summary'}")
    for marker, problem in (
        ("unittest.loader._FailedTest", "a module could not be loaded"),
        ("ERROR: setUpClass", "a class could not be set up"),
        ("ERROR: setUpModule", "a module could not be set up"),
        ("Creating test database", "Django created its own test database, which none of these tests uses"),
    ):
        if marker in log:
            problems.append(problem)
    for module, counts in sorted(outcomes.items()):
        others = {outcome: count for outcome, count in counts.items() if outcome != "ok"}
        if others:
            problems.append(f"{module}: {', '.join(f'{count} {outcome}' for outcome, count in sorted(others.items()))}")
        if module in modules and not counts["ok"]:
            problems.append(f"{module} ran no test")
        if module not in modules:
            problems.append(f"{module} ran, but was not asked for")
    passed = sum(counts["ok"] for counts in outcomes.values())
    if total and passed != total:
        problems.append(f"{total} tests ran, but {passed} are reported as passed")
    if not total:
        problems.append("no test ran")
    return problems, outcomes, total


def report(server: str, mode: str, outcomes: dict[str, Counter], total: int, problems: list[str]) -> str:
    verdict = "passed" if not problems else "FAILED"
    rows = "\n".join(f"| `{module}` | {counts['ok']} |" for module, counts in sorted(outcomes.items()))
    text = (
        f"### {server}, {mode}: {total} tests, {verdict}\n\n"
        f"| Module | Passed |\n| --- | --- |\n{rows}\n"
    )
    if problems:
        text += "\n" + "\n".join(f"- {problem}" for problem in problems) + "\n"
    return text


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--log", required=True)
    parser.add_argument("--mode", required=True)
    parser.add_argument("--server", required=True)
    parser.add_argument("modules", nargs="+")
    arguments = parser.parse_args(argv)
    with open(arguments.log, encoding="utf-8", errors="replace") as file:
        log = file.read()
    problems, outcomes, total = judge(log, arguments.modules)
    text = report(arguments.server, arguments.mode, outcomes, total, problems)
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as file:
            file.write(text + "\n")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
