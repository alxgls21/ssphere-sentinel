"""The basic failure rules, installed once with the alerts app.

Critical failures only, raising in-app incidents: nothing here sends email, and
no warning or unknown status opens an incident by default. A migration runs once
per database, so what an administrator later does to these rules (disable, edit,
delete) is never undone. Applied again (after a rollback), it adds only the rules
that are missing by key, and skips one whose name is already taken.
"""

from django.db import migrations
from django.db.models.functions import Lower

DEFAULT_RULES = (
    {
        "key": "server-offline",
        "name": "Server offline",
        "description": "The server's agent has stopped reporting for longer than the offline threshold.",
        "entity_kind": "server",
        "health": "critical",
        "reason": "offline",
        "activation_seconds": 60,
    },
    {
        "key": "target-failing",
        "name": "Network target failing",
        "description": "The latest probes of the target all failed.",
        "entity_kind": "target",
        "health": "critical",
        "reason": "failing",
        "activation_seconds": 60,
    },
    {
        "key": "device-unreachable",
        "name": "SNMP device unreachable",
        "description": "The device's SNMP polls have got no answer for ten minutes.",
        "entity_kind": "device",
        "health": "critical",
        "reason": "unreachable",
        # Polls are five minutes apart by default: the failures of three polls in a row, not one.
        "activation_seconds": 600,
    },
    {
        "key": "container-failed",
        "name": "Docker container unhealthy or dead",
        "description": "A running container fails its health check, or Docker reports it dead.",
        "entity_kind": "container",
        "health": "critical",
        "reason": "",
        "activation_seconds": 60,
    },
)


def install(apps, schema_editor):
    AlertRule = apps.get_model("alerts", "AlertRule")
    rules = AlertRule.objects.using(schema_editor.connection.alias)
    for rule in DEFAULT_RULES:
        taken = rules.filter(key=rule["key"]).exists() or rules.annotate(lower=Lower("name")).filter(lower=rule["name"].lower()).exists()
        if not taken:
            rules.create(
                **rule,
                enabled=True,
                condition="health",
                severity="critical",
                recovery_seconds=120,
            )


class Migration(migrations.Migration):
    dependencies = [
        ("alerts", "0001_initial_alerts"),
    ]

    operations = [
        migrations.RunPython(install, migrations.RunPython.noop),
    ]
