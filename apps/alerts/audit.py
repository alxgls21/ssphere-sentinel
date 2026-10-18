"""The configuration trail (``ConfigurationEvent``): who changed which rule or subscription, and how.

Called by the console API and the admin, inside the transaction of the change. Only
the object's own fields are recorded, by the names the console API gives them; none
of them is a credential.
"""

from __future__ import annotations

from django.utils import timezone

from apps.alerts.models import (
    AlertRule,
    ConfigurationAction,
    ConfigurationEvent,
    ConfigurationSource,
    ConfigurationTarget,
    NotificationSubscription,
    TestEmailRequest,
)

# Model field -> the name the console API uses for it.
RULE_FIELDS = {
    "name": "name",
    "description": "description",
    "enabled": "enabled",
    "entity_kind": "kind",
    "health": "health",
    "reason": "reason",
    "severity": "severity",
    "activation_seconds": "activationSeconds",
    "recovery_seconds": "recoverySeconds",
    "customer_id": "customerId",
    "site_id": "siteId",
}
SUBSCRIPTION_FIELDS = {"enabled": "enabled", "min_severity": "minSeverity", "send_recovery": "sendRecovery"}


def _json(value):
    return value if value is None or isinstance(value, (bool, int, str)) else str(value)


def rule_values(rule: AlertRule | None) -> dict:
    return {api: _json(getattr(rule, field)) for field, api in RULE_FIELDS.items()} if rule else {}


def subscription_values(subscription: NotificationSubscription | None) -> dict:
    return {api: _json(getattr(subscription, field)) for field, api in SUBSCRIPTION_FIELDS.items()} if subscription else {}


def changes(before: dict, after: dict) -> dict:
    """``{"field": {"before", "after"}}`` of what differs (a field missing on one side is null there)."""
    return {
        name: {"before": before.get(name), "after": after.get(name)}
        for name in sorted({*before, *after})
        if before.get(name) != after.get(name)
    }


def record(
    actor,
    *,
    source: str,
    action: str,
    target: str,
    target_id,
    target_name: str,
    changed: dict | None = None,
    actor_name: str | None = None,
):
    """``actor_name``: the name the actor had when they acted, when that was not now."""
    if actor_name is None:
        actor_name = actor.get_username() if actor is not None else ""
    return ConfigurationEvent.objects.create(
        at=timezone.now(),
        actor=actor if actor is not None and actor.pk is not None else None,
        actor_name=actor_name,
        source=source,
        action=action,
        target_type=target,
        target_id=str(target_id),
        target_name=target_name[:255],
        changes=changed or {},
    )


def rule_saved(actor, rule: AlertRule, before: dict, *, created: bool, source: str) -> list[ConfigurationEvent]:
    """The events of one save of ``rule``: created, or enabled/disabled and/or changed (nothing if nothing changed)."""
    after = rule_values(rule)
    common = {"source": source, "target": ConfigurationTarget.ALERT_RULE, "target_id": rule.pk, "target_name": rule.name}
    if created:
        return [record(actor, action=ConfigurationAction.RULE_CREATED, changed=changes({}, after), **common)]
    events = []
    diff = changes(before, after)
    switched = diff.pop("enabled", None)
    if switched is not None:
        action = ConfigurationAction.RULE_ENABLED if switched["after"] else ConfigurationAction.RULE_DISABLED
        events.append(record(actor, action=action, changed={"enabled": switched}, **common))
    if diff:
        events.append(record(actor, action=ConfigurationAction.RULE_CHANGED, changed=diff, **common))
    return events


def rule_deleted(actor, rule: AlertRule, *, source: str) -> ConfigurationEvent:
    return record(
        actor,
        source=source,
        action=ConfigurationAction.RULE_DELETED,
        target=ConfigurationTarget.ALERT_RULE,
        target_id=rule.pk,
        target_name=rule.name,
        changed=changes(rule_values(rule), {}),
    )


def subscription_saved(actor, subscription: NotificationSubscription, before: dict, *, source: str):
    """The event of one save of ``subscription`` (none if nothing changed)."""
    diff = changes(before, subscription_values(subscription))
    if not diff:
        return None
    return record(
        actor,
        source=source,
        action=ConfigurationAction.SUBSCRIPTION_CHANGED,
        target=ConfigurationTarget.SUBSCRIPTION,
        target_id=subscription.pk,
        target_name=subscription.user.get_username(),
        changed=diff,
    )


def subscription_deleted(actor, subscription: NotificationSubscription, *, source: str) -> ConfigurationEvent:
    return record(
        actor,
        source=source,
        action=ConfigurationAction.SUBSCRIPTION_DELETED,
        target=ConfigurationTarget.SUBSCRIPTION,
        target_id=subscription.pk,
        target_name=subscription.user.get_username(),
        changed=changes(subscription_values(subscription), {}),
    )


def subscription_deleted_with_account(sender, instance: NotificationSubscription, origin=None, **kwargs) -> None:
    """``pre_delete``: a subscription deleted because its account is (in the deletion's transaction).

    The admin records the deletions it makes itself, with who made them; this one has no
    known actor.
    """
    user_model = NotificationSubscription._meta.get_field("user").related_model
    # ``origin``: the account, or the queryset of accounts, whose deletion this is.
    if isinstance(origin, user_model) or getattr(origin, "model", None) is user_model:
        subscription_deleted(None, instance, source=ConfigurationSource.ACCOUNT_DELETED)


def test_email_requested(actor, request: TestEmailRequest) -> ConfigurationEvent:
    return record(
        actor,
        source=ConfigurationSource.CONSOLE,
        action=ConfigurationAction.TEST_EMAIL_REQUESTED,
        target=ConfigurationTarget.TEST_EMAIL,
        target_id=request.pk,
        target_name=actor.get_username(),
    )
