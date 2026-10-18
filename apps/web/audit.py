"""Domains in the configuration trail (``apps.alerts.audit``): added, verification asked for, answered.

Recorded in the transaction of the change. The token is never recorded: the domain's
own fields only, by the names the console API gives them.
"""

from __future__ import annotations

from apps.alerts.audit import changes, record
from apps.alerts.models import ConfigurationAction, ConfigurationSource, ConfigurationTarget
from apps.web import dns_verification as dns

# Model field -> the name the console API uses for it.
DOMAIN_FIELDS = {
    "name": "name",
    "display_name": "displayName",
    "customer_id": "customerId",
    "status": "status",
    "last_outcome": "lastOutcome",
}


def _json(value):
    return value if value is None or isinstance(value, (bool, int, str)) else str(value)


def domain_values(domain) -> dict:
    return {api: _json(getattr(domain, field)) for field, api in DOMAIN_FIELDS.items()}


def _common(domain) -> dict:
    return {"target": ConfigurationTarget.DOMAIN, "target_id": domain.pk, "target_name": domain.name}


def domain_created(actor, domain):
    return record(
        actor,
        source=ConfigurationSource.CONSOLE,
        action=ConfigurationAction.DOMAIN_CREATED,
        changed=changes({}, domain_values(domain)),
        **_common(domain),
    )


def verification_requested(actor, domain, verification):
    return record(
        actor,
        source=ConfigurationSource.CONSOLE,
        action=ConfigurationAction.DOMAIN_VERIFICATION_REQUESTED,
        changed={"verificationId": {"before": None, "after": str(verification.pk)}},
        **_common(domain),
    )


def verification_finished(domain, verification, before: dict):
    """The answer, for the account that asked (by the name it had then)."""
    verified = verification.outcome == dns.VERIFIED
    changed = changes(before, domain_values(domain))
    changed["verificationId"] = {"before": None, "after": str(verification.pk)}
    changed["detail"] = {"before": None, "after": verification.detail}
    return record(
        verification.requested_by,
        actor_name=verification.requested_by_name,
        source=ConfigurationSource.VERIFIER,
        action=ConfigurationAction.DOMAIN_VERIFIED if verified else ConfigurationAction.DOMAIN_VERIFICATION_FAILED,
        changed=changed,
        **_common(domain),
    )
