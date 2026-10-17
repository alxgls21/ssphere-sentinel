from django.utils import timezone

from apps.alerts.models import Notification
from apps.alerts.notifications import give_up_overdue, overdue
from apps.core.retention import RetentionCommand, delete_in_batches


class Command(RetentionCommand):
    help = (
        "Delete the records of incident emails sent, failed or not sent more than "
        "SENTINEL_NOTIFICATION_RETENTION_DAYS ago, in batches. Emails not sent within "
        "SENTINEL_NOTIFICATION_MAX_AGE_HOURS that no notifier holds are given up first; "
        "emails still to be sent are kept."
    )
    default_days_setting = "SENTINEL_NOTIFICATION_RETENTION_DAYS"

    def purge(self, *, cutoff, batch_size, dry_run):
        now = timezone.now()
        # Ended rows only: the notifier never touches them again.
        qs = Notification.objects.filter(status__in=Notification.ENDED, created_at__lt=cutoff)
        if dry_run:
            late = Notification.objects.filter(overdue(now))
            self.stdout.write(
                f"Would give up {late.count()} email(s) not sent in time, and delete "
                f"{(qs | late.filter(created_at__lt=cutoff)).count()} email record(s) older than {cutoff.isoformat()}."
            )
            return

        given_up = give_up_overdue(now)
        deleted, batches = delete_in_batches(qs, batch_size=batch_size)
        self.stdout.write(
            self.style.SUCCESS(
                f"Gave up {given_up} email(s) not sent in time. Deleted {deleted} email record(s) older than "
                f"{cutoff.isoformat()} in {batches} batch(es)."
            )
        )
