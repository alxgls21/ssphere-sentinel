"""What a console user may administer, beyond reading what their grants let them see.

Every check is made in the view, on the server; ``capabilities`` only tells the UI
what to offer (``/session/``).

* Alert rules: Django's model permissions on ``alerts.AlertRule`` (view, add, change;
  a rule is never deleted from the console: disable it), and **global visibility**
  (``console.view_all_customers``, or a superuser): a rule may concern every
  customer, and the list names the customers and sites the rules are for.
* The user's own email preferences: every console user (their own only).
* A test email to their own address: ``alerts.send_test_email``.
* The system's status (the alert engine, the notifier, the email outbox, settings
  that come from the environment): ``console.view_system_status`` and global
  visibility, since its counts concern every customer.
* Monitored domains: Django's model permissions on ``web.MonitoredDomain`` (view, add)
  and ``web.verify_monitoreddomain`` to ask for a verification, with **global
  visibility**: the list names every customer's domains. Whoever may add or verify
  domains may see them.
"""

from __future__ import annotations

from apps.console.access import Visibility
from apps.console.http import ApiError

ACKNOWLEDGE_INCIDENTS = "alerts.acknowledge_incident"
VIEW_RULES = "alerts.view_alertrule"
ADD_RULES = "alerts.add_alertrule"
CHANGE_RULES = "alerts.change_alertrule"
SEND_TEST_EMAIL = "alerts.send_test_email"
VIEW_SYSTEM_STATUS = "console.view_system_status"
VIEW_DOMAINS = "web.view_monitoreddomain"
ADD_DOMAINS = "web.add_monitoreddomain"
VERIFY_DOMAINS = "web.verify_monitoreddomain"


def may_view_rules(user, visibility: Visibility) -> bool:
    # As in the admin, who may change rules may view them.
    return visibility.all_access and (user.has_perm(VIEW_RULES) or user.has_perm(CHANGE_RULES))


def may_add_rules(user, visibility: Visibility) -> bool:
    return visibility.all_access and user.has_perm(ADD_RULES)


def may_change_rules(user, visibility: Visibility) -> bool:
    return visibility.all_access and user.has_perm(CHANGE_RULES)


def may_view_system_status(user, visibility: Visibility) -> bool:
    return visibility.all_access and user.has_perm(VIEW_SYSTEM_STATUS)


def may_add_domains(user, visibility: Visibility) -> bool:
    return visibility.all_access and user.has_perm(ADD_DOMAINS)


def may_verify_domains(user, visibility: Visibility) -> bool:
    return visibility.all_access and user.has_perm(VERIFY_DOMAINS)


def may_view_domains(user, visibility: Visibility) -> bool:
    return visibility.all_access and any(user.has_perm(name) for name in (VIEW_DOMAINS, ADD_DOMAINS, VERIFY_DOMAINS))


def require(allowed: bool, message: str) -> None:
    if not allowed:
        raise ApiError(403, "forbidden", message)


def capabilities(user, visibility: Visibility) -> dict[str, bool]:
    return {
        "acknowledgeIncidents": user.has_perm(ACKNOWLEDGE_INCIDENTS),
        "viewAlertRules": may_view_rules(user, visibility),
        "createAlertRules": may_add_rules(user, visibility),
        "editAlertRules": may_change_rules(user, visibility),
        "manageOwnNotifications": True,
        "sendTestEmail": user.has_perm(SEND_TEST_EMAIL),
        "viewSystemStatus": may_view_system_status(user, visibility),
        "viewDomains": may_view_domains(user, visibility),
        "addDomains": may_add_domains(user, visibility),
        "verifyDomains": may_verify_domains(user, visibility),
    }
