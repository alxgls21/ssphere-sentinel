from apps.core.retention import RetentionCommand, delete_in_batches
from apps.infrastructure.models import DockerContainer


class Command(RetentionCommand):
    help = (
        "Delete Docker containers that have been absent from successful "
        "discoveries for longer than SENTINEL_DOCKER_ABSENT_CONTAINER_RETENTION_DAYS. "
        "Present containers are never deleted."
    )
    default_days_setting = "SENTINEL_DOCKER_ABSENT_CONTAINER_RETENTION_DAYS"

    def purge(self, *, cutoff, batch_size, dry_run):
        # Containers only become absent after a successful discovery that no
        # longer lists them, so Docker outages never make rows eligible here.
        qs = DockerContainer.objects.filter(present=False, last_seen_at__lt=cutoff)
        if dry_run:
            self.stdout.write(
                f"Would delete {qs.count()} absent container(s) last seen before "
                f"{cutoff.isoformat()}."
            )
            return

        deleted, batches = delete_in_batches(qs, batch_size=batch_size)
        self.stdout.write(
            self.style.SUCCESS(
                f"Deleted {deleted} absent container(s) last seen before "
                f"{cutoff.isoformat()} in {batches} batch(es)."
            )
        )
