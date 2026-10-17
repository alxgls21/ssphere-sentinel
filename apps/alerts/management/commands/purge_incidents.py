from django.utils import timezone

from apps.alerts.models import Incident, IncidentEvent, Notification
from apps.alerts.notifications import overdue
from apps.core.retention import RetentionCommand, delete_in_batches


class Command(RetentionCommand):
    help = (
        "Delete incidents that ended (recovered or closed) more than SENTINEL_INCIDENT_RETENTION_DAYS ago, "
        "with their history and their email records, in batches. Open incidents are never deleted, nor "
        "one with an email still to be sent (not one past SENTINEL_NOTIFICATION_MAX_AGE_HOURS that no "
        "notifier holds: it will not be sent)."
    )
    default_days_setting = "SENTINEL_INCIDENT_RETENTION_DAYS"

    def purge(self, *, cutoff, batch_size, dry_run):
        now = timezone.now()
        # Only ended incidents, which never change again, and whose emails have all ended or
        # are overdue (no notifier will send them; those of other incidents are left to
        # purge_notifications): none is added (emails come with a step of an open incident),
        # and no row is revived under the batches.
        waiting = Notification.objects.filter(
            status__in=[Notification.Status.PENDING, Notification.Status.SENDING]
        ).exclude(overdue(now))
        qs = Incident.objects.filter(status__in=Incident.ENDED, closed_at__lt=cutoff).exclude(
            pk__in=waiting.values("incident_id")
        )
        if dry_run:
            self.stdout.write(
                f"Would delete {qs.count()} incident(s) that ended before {cutoff.isoformat()}, with "
                f"{IncidentEvent.objects.filter(incident__in=qs).count()} event(s) and "
                f"{Notification.objects.filter(incident__in=qs).count()} email record(s)."
            )
            return

        deleted, batches = delete_in_batches(qs, batch_size=batch_size)
        self.stdout.write(
            self.style.SUCCESS(
                f"Deleted {deleted} row(s) of incidents that ended before {cutoff.isoformat()} "
                f"(with their events and email records) in {batches} batch(es)."
            )
        )
