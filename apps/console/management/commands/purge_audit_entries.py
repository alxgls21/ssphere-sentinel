from apps.console.models import AuditEntry
from apps.core.retention import RetentionCommand, delete_in_batches


class Command(RetentionCommand):
    help = (
        "Delete audit entries (the console's trail of administrative actions) older than "
        "SENTINEL_AUDIT_RETENTION_DAYS, in batches. The trail is otherwise never changed or deleted."
    )
    default_days_setting = "SENTINEL_AUDIT_RETENTION_DAYS"

    def purge(self, *, cutoff, batch_size, dry_run):
        qs = AuditEntry.objects.filter(at__lt=cutoff)
        if dry_run:
            self.stdout.write(f"Would delete {qs.count()} audit entr(y/ies) older than {cutoff.isoformat()}.")
            return
        deleted, batches = delete_in_batches(qs, batch_size=batch_size)
        self.stdout.write(
            self.style.SUCCESS(f"Deleted {deleted} audit entr(y/ies) older than {cutoff.isoformat()} in {batches} batch(es).")
        )
