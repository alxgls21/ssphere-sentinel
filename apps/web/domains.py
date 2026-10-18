"""A domain as Sentinel keeps it, and the DNS record that proves it is the customer's.

``normalize`` turns what a user typed into the one spelling everything compares and
stores: the ASCII form (A-labels) of UTS #46 processing with IDNA2008 rules
(non-transitional, STD3), lowercase, without a final dot; and the Unicode form
(U-labels) to show. It accepts a registrable domain (``example.co.uk``) or a name
under one (``shop.example.co.uk``), and refuses an IP address, a single label, an
invalid or malformed label, a name too long to have the record under it, a public
suffix (``co.uk``, ``github.io``: the Public Suffix List, its ICANN and PRIVATE
sections), a name under no suffix the list knows, and the special-use names
(``.local``, ``.test``, ``.arpa`` and the like), which have no public DNS to verify.

The record (``record_name``, ``record_value``)::

    _ssphere-sentinel.<domain>  TXT  "ssphere-verification=<token>"

The token is public DNS material, not a credential: it proves who can change the
domain's DNS, and only for the customer it was made for. Each customer and domain
gets its own, random (256 bits), never derived from anything.
"""

from __future__ import annotations

import ipaddress
import re
import secrets

import idna
from publicsuffixlist import PublicSuffixList

RECORD_LABEL = "_ssphere-sentinel"
VALUE_PREFIX = "ssphere-verification="
TOKEN_BYTES = 32
TOKEN_LENGTH = 43  # token_urlsafe(32): 256 bits in unpadded base64url
# A DNS name is at most 253 characters; the record's is the domain's and 18 more.
MAX_LENGTH = 253 - len(RECORD_LABEL) - 1
MAX_INPUT_LENGTH = 1024
MAX_DISPLAY_LENGTH = 255
# Names with no public DNS (RFC 6761, 6762, 7686, 8375, 9476, ICANN's .internal).
SPECIAL_USE = frozenset({"alt", "arpa", "example", "internal", "invalid", "local", "localhost", "onion", "test"})
LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
FINAL_DOTS = (".", "。", "．", "｡")  # what UTS #46 maps to a dot

# The list as published when the installed release was made (the package is updated
# with the server's other dependencies). Unknown top-level labels are refused.
_SUFFIXES = PublicSuffixList(accept_unknown=False, only_icann=False)


class InvalidDomain(ValueError):
    """A name that cannot be a monitored domain; the message says why, without echoing it."""


def normalize(text) -> tuple[str, str]:
    """``(ascii, display)`` of ``text``, or :class:`InvalidDomain`."""
    if not isinstance(text, str):
        raise InvalidDomain("Expected a domain name.")
    text = text.strip()
    if not text:
        raise InvalidDomain("Enter a domain name.")
    if len(text) > MAX_INPUT_LENGTH:
        raise InvalidDomain("This name is too long.")
    if text.endswith(FINAL_DOTS):
        text = text[:-1]
    if _is_address(text):
        raise InvalidDomain("Enter a domain name, not an IP address.")
    try:
        ascii_name = idna.encode(text, uts46=True, transitional=False, std3_rules=True).decode("ascii")
        display = idna.decode(ascii_name)
        # A-labels that do not decode to what they say (or to a different spelling) are refused.
        if idna.encode(display).decode("ascii") != ascii_name:
            raise InvalidDomain("This is not a valid domain name.")
    except (idna.IDNAError, UnicodeError):
        raise InvalidDomain("This is not a valid domain name.") from None
    labels = ascii_name.split(".")
    if len(labels) < 2:
        raise InvalidDomain("Enter a full domain name, such as example.com.")
    if not all(LABEL.match(label) for label in labels):
        raise InvalidDomain("This is not a valid domain name.")
    if labels[-1].isdigit() or _is_address(ascii_name):
        raise InvalidDomain("Enter a domain name, not an IP address.")
    if len(ascii_name) > MAX_LENGTH or len(display) > MAX_DISPLAY_LENGTH:
        raise InvalidDomain(f"This name is too long: at most {MAX_LENGTH} characters in its ASCII form.")
    if labels[-1] in SPECIAL_USE:
        raise InvalidDomain("This name is for local or special use and has no public DNS.")
    if _SUFFIXES.is_public(ascii_name):
        raise InvalidDomain("This is a public suffix, under which anyone can register: enter your own domain.")
    if _SUFFIXES.privatesuffix(ascii_name) is None:
        raise InvalidDomain("This name is not under a known public domain suffix.")
    return ascii_name, display


def registrable(name: str) -> str | None:
    """The registrable domain (one label under a public suffix) ``name`` is under, or None:
    a public suffix itself, a name under no suffix the list knows, or a special-use name."""
    name = name.lower().rstrip(".")
    labels = name.split(".")
    if len(labels) < 2 or labels[-1] in SPECIAL_USE:
        return None
    return _SUFFIXES.privatesuffix(name)


def _is_address(text: str) -> bool:
    candidate = text[1:-1] if text.startswith("[") and text.endswith("]") else text
    try:
        ipaddress.ip_address(candidate)
    except ValueError:
        return False
    return True


def new_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def record_name(ascii_name: str) -> str:
    return f"{RECORD_LABEL}.{ascii_name}"


def record_value(token: str) -> str:
    return f"{VALUE_PREFIX}{token}"
