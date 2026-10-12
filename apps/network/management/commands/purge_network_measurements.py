from apps.core.retention import RetentionCommand, delete_in_batches
from apps.network.models import NetworkMeasurement


class Command(RetentionCommand):
    help = (
        "Delete network measurements older than "
        "SENTINEL_NETWORK_MEASUREMENT_RETENTION_DAYS, in batches."
    )
    default_days_setting = "SENTINEL_NETWORK_MEASUREMENT_RETENTION_DAYS"

    def purge(self, *, cutoff, batch_size, dry_run):
        qs = NetworkMeasurement.objects.filter(measured_at__lt=cutoff)
        if dry_run:
            self.stdout.write(
                f"Would delete {qs.count()} measurement(s) older than {cutoff.isoformat()}."
            )
            return

        deleted, batches = delete_in_batches(qs, batch_size=batch_size)
        self.stdout.write(
            self.style.SUCCESS(
                f"Deleted {deleted} measurement row(s) older than {cutoff.isoformat()} "
                f"in {batches} batch(es)."
            )
        )
