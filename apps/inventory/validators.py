"""Validation of network device management addresses."""

from __future__ import annotations

import ipaddress
import re

from django.core.exceptions import ValidationError

MAX_ADDRESS_LENGTH = 255

# Same rules as the agent's target validation (agent/network_config.py): labels
# of alphanumerics and hyphens, no underscores, spaces or shell characters.
# Kept here rather than imported because the agent is a separate distribution.
_HOSTNAME_RE = re.compile(
    r"^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$"
)
# Shell and path metacharacters: ; & | ` $ < > \ " '
_FORBIDDEN_CHARS_RE = re.compile(r"""[;&|`$<>\\"']""")


def validate_management_address(value: str) -> None:
    """Accept a hostname or a unicast IPv4/IPv6 address, nothing else.

    The value is later handed to a poller, so whitespace, shell and path
    metacharacters are rejected outright even though pollers never use a shell.
    """
    host = value.strip() if isinstance(value, str) else ""
    if not host or len(host) > MAX_ADDRESS_LENGTH:
        raise ValidationError("Enter a hostname or an IP address.", code="invalid")
    if host != value or any(char.isspace() for char in host):
        raise ValidationError("The address must not contain whitespace.", code="invalid")
    if _FORBIDDEN_CHARS_RE.search(host):
        raise ValidationError("The address contains forbidden characters.", code="invalid")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        if not _HOSTNAME_RE.match(host):
            raise ValidationError(
                "Enter a valid hostname or IP address.", code="invalid"
            ) from None
        if host.rsplit(".", 1)[-1].isdigit():
            # A hostname's last label is never all digits (RFC 3696): this is a
            # mistyped IP address such as 256.1.1.1 or 192.0.2.
            raise ValidationError(
                "This looks like an IP address but is not a valid one.", code="invalid"
            ) from None
        return
    if address.is_unspecified or address.is_multicast:
        raise ValidationError(
            "The address must be a unicast address (not unspecified or multicast).",
            code="invalid",
        )
