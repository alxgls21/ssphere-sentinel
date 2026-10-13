"""Strict query-string parsing and pagination for the console's list endpoints.

Every list endpoint declares the parameters it accepts; anything else is a
400 rather than being ignored, because a silently ignored ``?sit=...`` would
answer with a wider (still authorized, but wrong) list. A parameter given
twice, an empty value where a choice or number is expected, a number that is
not plain ASCII digits, control characters (NUL included: PostgreSQL rejects
them) and over-long values are 400 too. Error messages name the parameter and
never echo what was sent.

Pagination is by page number with a bounded page size. ``page`` is bounded as
well, so an offset can never be an arbitrary large number.
"""

from __future__ import annotations

import math
import unicodedata
from collections.abc import Collection
from uuid import UUID

from django.http import HttpRequest

from apps.console.access import Scope, Visibility
from apps.console.http import ApiError

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200
MAX_PAGE = 10_000
MAX_SEARCH_LENGTH = 200
MAX_SEARCH_WORDS = 8
MAX_UUID_LENGTH = 36


def invalid(name: str, reason: str) -> ApiError:
    return ApiError(400, "invalid_parameter", f"Invalid query parameter '{name}': {reason}.")


class QueryParams:
    """The checked query string of one request."""

    def __init__(self, request: HttpRequest, allowed: Collection[str]) -> None:
        self._values: dict[str, str] = {}
        for name in request.GET:
            if name not in allowed:
                raise ApiError(
                    400,
                    "unknown_parameter",
                    f"Unknown query parameter. Allowed: {', '.join(sorted(allowed))}.",
                )
            values = request.GET.getlist(name)
            if len(values) != 1:
                raise invalid(name, "give it once")
            self._values[name] = values[0]

    def choice(self, name: str, choices: Collection[str], default: str) -> str:
        raw = self._values.get(name)
        if raw is None:
            return default
        if raw not in choices:
            raise invalid(name, f"expected one of {', '.join(sorted(choices))}")
        return raw

    def integer(self, name: str, *, minimum: int, maximum: int, default: int) -> int:
        raw = self._values.get(name)
        if raw is None:
            return default
        # ``int()`` also accepts signs, spaces, underscores and non-ASCII digits.
        if not (raw.isascii() and raw.isdigit() and len(raw) <= 9):
            raise invalid(name, f"expected a whole number from {minimum} to {maximum}")
        value = int(raw)
        if not minimum <= value <= maximum:
            raise invalid(name, f"expected a whole number from {minimum} to {maximum}")
        return value

    def uuid(self, name: str) -> UUID | None:
        raw = self._values.get(name)
        if raw is None:
            return None
        try:
            parsed = UUID(raw) if len(raw) <= MAX_UUID_LENGTH else None
        except ValueError:
            parsed = None
        # Only the canonical spelling: no braces, ``urn:`` prefix or missing hyphens.
        if parsed is None or str(parsed) != raw.lower():
            raise invalid(name, "expected a UUID")
        return parsed

    def scope(self, visibility: Visibility) -> Scope:
        """The ``customer`` / ``site`` parameters, checked against the user's grants.

        A malformed id is a 400 (the request is wrong, whoever sends it); a
        well-formed id that does not exist, is not visible, or a site that is
        not the customer's is a 404 and looks the same in every case.
        """
        return visibility.resolve_scope(self.uuid("customer"), self.uuid("site"))

    def search(self, name: str = "q") -> list[str]:
        """The words of a search box: every word must match (see the endpoints)."""
        raw = self._values.get(name)
        if raw is None:
            return []
        if len(raw) > MAX_SEARCH_LENGTH:
            raise invalid(name, f"at most {MAX_SEARCH_LENGTH} characters")
        # Tabs and newlines just separate words; NUL and the other controls are refused
        # (PostgreSQL cannot store NUL in text, so it would be a 500).
        if any(unicodedata.category(char) == "Cc" and not char.isspace() for char in raw):
            raise invalid(name, "control characters are not allowed")
        # Not normalised: the stored text is not, so what a user copies from the UI must match as typed.
        words = raw.split()
        if len(words) > MAX_SEARCH_WORDS:
            raise invalid(name, f"at most {MAX_SEARCH_WORDS} words")
        return words


class PageRequest:
    """``page`` and ``pageSize`` of a list request."""

    def __init__(self, number: int, size: int) -> None:
        self.number = number
        self.size = size

    @classmethod
    def from_params(cls, params: QueryParams) -> PageRequest:
        return cls(
            params.integer("page", minimum=1, maximum=MAX_PAGE, default=1),
            params.integer("pageSize", minimum=1, maximum=MAX_PAGE_SIZE, default=DEFAULT_PAGE_SIZE),
        )

    @property
    def offset(self) -> int:
        return (self.number - 1) * self.size

    def payload(self, total: int) -> dict[str, int]:
        """The ``page`` object: a page beyond the last is empty, not an error."""
        return {
            "number": self.number,
            "size": self.size,
            "total": total,
            "pages": max(1, math.ceil(total / self.size)),
        }


SCOPE_PARAMS = ("customer", "site")
PAGE_PARAMS = ("page", "pageSize")
