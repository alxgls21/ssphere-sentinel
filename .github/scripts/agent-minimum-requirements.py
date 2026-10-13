"""Print the lowest version of every agent dependency, as exact pins.

CI installs these to check that the lower bounds declared in agent/pyproject.toml
still work. Run from the repository root.
"""

import re
import sys
import tomllib

with open("agent/pyproject.toml", "rb") as handle:
    project = tomllib.load(handle)["project"]

specs = [*project["dependencies"], *(spec for extra in project["optional-dependencies"].values() for spec in extra)]
for spec in specs:
    name = re.match(r"[A-Za-z0-9_.-]+", spec)[0]
    lower = re.search(r">=\s*([^,;\s]+)", spec)
    if lower is None:
        sys.exit(f"{spec}: no lower bound")
    print(f"{name}=={lower[1]}")
