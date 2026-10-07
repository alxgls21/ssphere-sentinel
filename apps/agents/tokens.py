"""Agent token generation and hashing.

Raw tokens are high-entropy secrets. Only HMAC-SHA256 digests (peppered with
Django's SECRET_KEY) are persisted. Never log or store the raw token.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

from django.conf import settings

TOKEN_BYTES = 32


def generate_token() -> str:
    """Return a cryptographically secure raw agent token."""
    return secrets.token_urlsafe(TOKEN_BYTES)


def hash_token(raw_token: str) -> str:
    """Return a deterministic HMAC-SHA256 digest for storage and lookup."""
    return hmac.new(
        key=settings.SECRET_KEY.encode("utf-8"),
        msg=raw_token.encode("utf-8"),
        digestmod=hashlib.sha256,
    ).hexdigest()
