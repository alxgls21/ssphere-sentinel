"""What a console user may administer, beyond reading what their grants let them see.

Every check is made in the view, on the server; ``capabilities`` only tells the UI
what to offer (``/session/``).

* Alert rules: Django's model permissions on ``alerts.AlertRule`` (view, add, change;
  a rule is never deleted from the console: disable it), and **global visibility**
  (``console.view_all_customers``, or a superuser): a rule may concern every
  customer, and the list names the customers and sites the rules are for.
* The user's own email preferences, and their own password: every console user (their own only).
* A test email to their own address: ``alerts.send_test_email``.
* The system's status (the alert engine, the notifier, the email outbox, settings
  that come from the environment): ``console.view_system_status`` and global
  visibility, since its counts concern every customer.
* Monitored domains: Django's model permissions on ``web.MonitoredDomain`` (view, add)
  and ``web.verify_monitoreddomain`` to ask for a verification, with **global
  visibility**: the list names every customer's domains. Whoever may add or verify
  domains may see them.
* Monitored hosts (adding a server, its agent and the agent's token, rotating the
  token, enabling or disabling the agent; changing or deleting a server): the accounts
  that may change alert rules (``alerts.change_alertrule`` with global visibility,
  **the mark of an account that configures monitoring**) **and** hold the model
  permission the admin asks for the same action: ``infrastructure.add_server``,
  ``infrastructure.change_server``, ``infrastructure.delete_server``,
  ``agents.add_agent``, ``agents.change_agent``. A server may be placed on any
  customer's site, and an agent's token monitors a host whoever may see it. The
  ``manageServers`` capability is announced only to an account that holds the three
  the enrolment needs, so the UI never offers a write the API refuses.
* Customers and sites, network targets, devices (with their SNMP configuration):
  the same rule, with the admin's model permissions on ``inventory.Customer``,
  ``inventory.Site``, ``network.NetworkTarget``, ``inventory.Device`` and
  ``snmp.SnmpConfig`` (add, change, delete). Reading them in the console needs only
  what reading anything needs: the grants, through ``apps.console.access``.
* Users and their access (accounts, roles, grants, passwords, sign-in lockouts):
  **administrators only** (a superuser). Whoever may change accounts can give any
  account, their own included, anything: there is no lesser permission for it.
* The audit trail: ``console.view_auditentry`` with global visibility (the entries
  name every customer's objects). Administrators hold it; it can be granted alone.

**Roles.** The console names four bundles of these permissions, so an administrator
assigns a role instead of permissions (``apps.console.users``): a *viewer* reads what
its grants let it see; an *operator* also acknowledges incidents and may ask for a
test email; an *editor* configures monitoring for every customer (hosts, targets,
devices, customers and sites, alert rules, domains) and sees the system status; an
*administrator* is a superuser (and may use the admin). The role of an account is
derived from the permissions it holds, directly or through its groups: the highest
role whose every permission it holds. Assigning a role from the console sets exactly
that role's permissions on the account and takes it out of every group, so what the
console says an account may do is what it may do. A finer grant (one permission more
or less) is still made in the admin, and shows here as the role it amounts to.
"""

from __future__ import annotations

from apps.console.access import USE_CONSOLE, VIEW_ALL_CUSTOMERS, Visibility
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
# The model permissions the admin asks for the same actions on monitored hosts.
ADD_SERVERS = "infrastructure.add_server"
CHANGE_SERVERS = "infrastructure.change_server"
DELETE_SERVERS = "infrastructure.delete_server"
ADD_AGENTS = "agents.add_agent"
CHANGE_AGENTS = "agents.change_agent"
# ... on customers and sites, network targets, devices and their SNMP configuration.
CUSTOMER_PERMISSIONS = ("inventory.add_customer", "inventory.change_customer", "inventory.delete_customer")
SITE_PERMISSIONS = ("inventory.add_site", "inventory.change_site", "inventory.delete_site")
TARGET_PERMISSIONS = ("network.add_networktarget", "network.change_networktarget", "network.delete_networktarget")
DEVICE_PERMISSIONS = ("inventory.add_device", "inventory.change_device", "inventory.delete_device")
SNMP_PERMISSIONS = ("snmp.add_snmpconfig", "snmp.change_snmpconfig", "snmp.delete_snmpconfig")
# The audit trail (``console.AuditEntry`` has only this permission).
VIEW_AUDIT_LOG = "console.view_auditentry"

# -- roles ---------------------------------------------------------------------------------

VIEWER = "viewer"
OPERATOR = "operator"
EDITOR = "editor"
ADMINISTRATOR = "administrator"
ROLES = (VIEWER, OPERATOR, EDITOR, ADMINISTRATOR)
ROLE_LABELS = {
    VIEWER: "Viewer",
    OPERATOR: "Operator",
    EDITOR: "Editor",
    ADMINISTRATOR: "Administrator",
}
_OPERATOR_PERMISSIONS = frozenset({USE_CONSOLE, ACKNOWLEDGE_INCIDENTS, SEND_TEST_EMAIL})
ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    VIEWER: frozenset({USE_CONSOLE}),
    OPERATOR: _OPERATOR_PERMISSIONS,
    EDITOR: _OPERATOR_PERMISSIONS
    | {
        VIEW_ALL_CUSTOMERS,
        VIEW_SYSTEM_STATUS,
        VIEW_RULES,
        ADD_RULES,
        CHANGE_RULES,
        VIEW_DOMAINS,
        ADD_DOMAINS,
        VERIFY_DOMAINS,
        ADD_SERVERS,
        CHANGE_SERVERS,
        DELETE_SERVERS,
        ADD_AGENTS,
        CHANGE_AGENTS,
        *CUSTOMER_PERMISSIONS,
        *SITE_PERMISSIONS,
        *TARGET_PERMISSIONS,
        *DEVICE_PERMISSIONS,
        *SNMP_PERMISSIONS,
    },
    # An administrator is a superuser: every permission, whatever the bundle below says.
    ADMINISTRATOR: frozenset(),
}


def role_of(is_superuser: bool, held: set[str] | frozenset[str]) -> str | None:
    """The role an account's permissions amount to (``held``: ``app.codename`` of every permission it has).

    A superuser is an administrator; otherwise the highest role whose every permission is
    held; ``None`` for an account that may not even use the console.
    """
    if is_superuser:
        return ADMINISTRATOR
    for role in (EDITOR, OPERATOR, VIEWER):
        if ROLE_PERMISSIONS[role] <= held:
            return role
    return None


# -- checks --------------------------------------------------------------------------------


def may_view_rules(user, visibility: Visibility) -> bool:
    # As in the admin, who may change rules may view them.
    return visibility.all_access and (user.has_perm(VIEW_RULES) or user.has_perm(CHANGE_RULES))


def may_add_rules(user, visibility: Visibility) -> bool:
    return visibility.all_access and user.has_perm(ADD_RULES)


def may_change_rules(user, visibility: Visibility) -> bool:
    return visibility.all_access and user.has_perm(CHANGE_RULES)


def configures_monitoring(user, visibility: Visibility) -> bool:
    """The mark of an account that configures monitoring: it may change alert rules, for every customer."""
    return may_change_rules(user, visibility)


def may_view_system_status(user, visibility: Visibility) -> bool:
    return visibility.all_access and user.has_perm(VIEW_SYSTEM_STATUS)


def may_add_domains(user, visibility: Visibility) -> bool:
    return visibility.all_access and user.has_perm(ADD_DOMAINS)


def may_verify_domains(user, visibility: Visibility) -> bool:
    return visibility.all_access and user.has_perm(VERIFY_DOMAINS)


def may_view_domains(user, visibility: Visibility) -> bool:
    return visibility.all_access and any(user.has_perm(name) for name in (VIEW_DOMAINS, ADD_DOMAINS, VERIFY_DOMAINS))


def _configures_with(user, visibility: Visibility, *permissions: str) -> bool:
    """Configures monitoring, and holds every one of ``permissions`` (the admin's, for the same actions)."""
    return configures_monitoring(user, visibility) and all(user.has_perm(name) for name in permissions)


def may_add_servers(user, visibility: Visibility) -> bool:
    """Add a server: who may change rules, with the admin's permission to add a server."""
    return _configures_with(user, visibility, ADD_SERVERS)


def may_change_servers(user, visibility: Visibility) -> bool:
    """Change a server's name, hostname, address, system, description or site."""
    return _configures_with(user, visibility, CHANGE_SERVERS)


def may_delete_servers(user, visibility: Visibility) -> bool:
    """Delete a server, with its agent, telemetry and containers."""
    return _configures_with(user, visibility, DELETE_SERVERS)


def may_add_agents(user, visibility: Visibility) -> bool:
    """Create a server's agent (and its token): who may change rules, with the admin's permission to add an agent."""
    return _configures_with(user, visibility, ADD_AGENTS)


def may_change_agents(user, visibility: Visibility) -> bool:
    """Rotate an agent's token, enable or disable it: who may change rules, with the admin's permission to change an agent."""
    return _configures_with(user, visibility, CHANGE_AGENTS)


def may_manage_servers(user, visibility: Visibility) -> bool:
    """Every write of the enrolment of monitored hosts: what the session announces as ``manageServers``."""
    return may_add_servers(user, visibility) and may_add_agents(user, visibility) and may_change_agents(user, visibility)


def may_add_customers(user, visibility: Visibility) -> bool:
    return _configures_with(user, visibility, CUSTOMER_PERMISSIONS[0])


def may_change_customers(user, visibility: Visibility) -> bool:
    return _configures_with(user, visibility, CUSTOMER_PERMISSIONS[1])


def may_delete_customers(user, visibility: Visibility) -> bool:
    return _configures_with(user, visibility, CUSTOMER_PERMISSIONS[2])


def may_add_sites(user, visibility: Visibility) -> bool:
    return _configures_with(user, visibility, SITE_PERMISSIONS[0])


def may_change_sites(user, visibility: Visibility) -> bool:
    return _configures_with(user, visibility, SITE_PERMISSIONS[1])


def may_delete_sites(user, visibility: Visibility) -> bool:
    return _configures_with(user, visibility, SITE_PERMISSIONS[2])


def may_manage_customers(user, visibility: Visibility) -> bool:
    """Every write on customers and sites: what the session announces as ``manageCustomers``."""
    return _configures_with(user, visibility, *CUSTOMER_PERMISSIONS, *SITE_PERMISSIONS)


def may_add_targets(user, visibility: Visibility) -> bool:
    return _configures_with(user, visibility, TARGET_PERMISSIONS[0])


def may_change_targets(user, visibility: Visibility) -> bool:
    return _configures_with(user, visibility, TARGET_PERMISSIONS[1])


def may_delete_targets(user, visibility: Visibility) -> bool:
    return _configures_with(user, visibility, TARGET_PERMISSIONS[2])


def may_manage_targets(user, visibility: Visibility) -> bool:
    """Every write on network targets: what the session announces as ``manageTargets``."""
    return _configures_with(user, visibility, *TARGET_PERMISSIONS)


def may_add_devices(user, visibility: Visibility) -> bool:
    return _configures_with(user, visibility, DEVICE_PERMISSIONS[0], SNMP_PERMISSIONS[0])


def may_change_devices(user, visibility: Visibility) -> bool:
    return _configures_with(user, visibility, DEVICE_PERMISSIONS[1], *SNMP_PERMISSIONS)


def may_delete_devices(user, visibility: Visibility) -> bool:
    return _configures_with(user, visibility, DEVICE_PERMISSIONS[2], SNMP_PERMISSIONS[2])


def may_manage_devices(user, visibility: Visibility) -> bool:
    """Every write on devices and their SNMP configuration: what the session announces as ``manageDevices``."""
    return _configures_with(user, visibility, *DEVICE_PERMISSIONS, *SNMP_PERMISSIONS)


def may_manage_users(user, visibility: Visibility) -> bool:
    """Accounts, roles, grants, passwords and lockouts: administrators (superusers) only."""
    return bool(user.is_active and user.is_superuser)


def may_view_audit_log(user, visibility: Visibility) -> bool:
    return visibility.all_access and user.has_perm(VIEW_AUDIT_LOG)


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
        "manageOwnAccount": True,
        "sendTestEmail": user.has_perm(SEND_TEST_EMAIL),
        "viewSystemStatus": may_view_system_status(user, visibility),
        "viewDomains": may_view_domains(user, visibility),
        "addDomains": may_add_domains(user, visibility),
        "verifyDomains": may_verify_domains(user, visibility),
        "manageServers": may_manage_servers(user, visibility),
        "editServers": may_change_servers(user, visibility),
        "deleteServers": may_delete_servers(user, visibility),
        "manageCustomers": may_manage_customers(user, visibility),
        "manageTargets": may_manage_targets(user, visibility),
        "manageDevices": may_manage_devices(user, visibility),
        "manageUsers": may_manage_users(user, visibility),
        "viewAuditLog": may_view_audit_log(user, visibility),
    }
