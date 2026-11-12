"""Parsing of the fields of a write body, shared by every console write.

Each helper reads one field of the JSON object a write sent, checks its shape and bounds, and
puts what is wrong with it in ``errors`` under the body's own name of the field (the shape of a
400 ``validation_error``, see ``apps.console.http``). The model's own checks (the address, the
unique name, a port that does not fit the protocol) are not repeated here: the model validates
on save, and its errors are mapped to the same field names by the caller.
"""

from __future__ import annotations

import unicodedata
from collections.abc import Collection
from uuid import UUID

from apps.console.http import storable_text
from apps.console.params import canonical_uuid


def controls(value: str, *, allowed: str = "") -> bool:
    """Whether ``value`` holds a control character (Unicode category Cc) other than those ``allowed``."""
    return any(unicodedata.category(char) == "Cc" and char not in allowed for char in value)


def text(data: dict, name: str, *, limit: int, errors: dict, multiline: bool = False) -> str:
    """The text of an optional field ("" when absent), with what is wrong with it in ``errors``.

    Control characters are refused, as ``apps.console.params`` refuses them in a search: a line
    break or an escape sequence in a name would end up in an email or a log line. A multi-line
    field keeps its tabs and line breaks; the others are stripped by the caller, so what is
    stripped away is not held against them.
    """
    value = data.get(name, "")
    if not isinstance(value, str):
        errors[name] = ["Expected text."]
        return ""
    if not storable_text(value):
        errors[name] = ["This text cannot be stored."]
        return ""
    if len(value) > limit:
        errors[name] = [f"At most {limit} characters."]
        return ""
    if controls(value if multiline else value.strip(), allowed="\t\n\r" if multiline else ""):
        errors[name] = ["Control characters are not allowed."]
        return ""
    return value


def boolean(data: dict, name: str, *, errors: dict) -> bool | None:
    """The value of a true-or-false field; ``None`` (and an error) for anything else."""
    value = data.get(name)
    if not isinstance(value, bool):
        errors[name] = ["Expected true or false."]
        return None
    return value


def integer(data: dict, name: str, *, errors: dict, minimum: int, maximum: int) -> int | None:
    """A whole number from ``minimum`` to ``maximum``; ``None`` (and an error) for anything else."""
    value = data.get(name)
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        errors[name] = [f"Expected a whole number from {minimum} to {maximum}."]
        return None
    return value


def choice(data: dict, name: str, *, errors: dict, choices: Collection[str]) -> str | None:
    """One of ``choices``; ``None`` (and an error) for anything else."""
    value = data.get(name)
    if not isinstance(value, str) or value not in choices:
        errors[name] = [f"Expected one of {', '.join(sorted(choices))}."]
        return None
    return value


def reference(data: dict, name: str, *, errors: dict, model, label: str) -> UUID | None:
    """The id of an existing row of ``model``; ``None`` for a null value, or (with an error) for anything else."""
    value = data.get(name)
    if value is None:
        return None
    parsed = canonical_uuid(value)
    if parsed is None:
        errors[name] = [f"Expected the id of a {label}."]
        return None
    if not model.objects.filter(pk=parsed).exists():
        errors[name] = [f"No such {label}."]
        return None
    return parsed


def unknown_fields(data: dict, allowed: Collection[str], errors: dict) -> None:
    """Every field of ``data`` that is not ``allowed`` is refused (a misspelt field must not be ignored)."""
    for name in sorted(set(data) - set(allowed)):
        errors[name] = ["Unknown field."]


def model_errors(error, names: dict[str, str]) -> dict[str, list[str]]:
    """A model's ``ValidationError`` by the body's field names (``names``: model field -> body field; ``nonField`` otherwise)."""
    fields: dict[str, list[str]] = {}
    for model_field, messages in error.message_dict.items():
        name = names.get(model_field, "nonField")
        for message in messages:
            if message not in fields.setdefault(name, []):
                fields[name].append(message)
    return fields
