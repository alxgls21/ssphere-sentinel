from django.db.models import Exists, OuterRef

from apps.core.retention import RetentionCommand, delete_in_batches
from apps.snmp.models import DevicePoll, Interface, InterfaceSample


class Command(RetentionCommand):
    help = (
        "Delete SNMP polls and interface samples older than "
        "SENTINEL_SNMP_RETENTION_DAYS, in batches, then the interfaces that "
        "are absent from their device and have no samples left."
    )
    default_days_setting = "SENTINEL_SNMP_RETENTION_DAYS"

    def purge(self, *, cutoff, batch_size, dry_run):
        samples = InterfaceSample.objects.filter(measured_at__lt=cutoff)
        polls = DevicePoll.objects.filter(measured_at__lt=cutoff)
        if dry_run:
            remaining = InterfaceSample.objects.filter(
                interface=OuterRef("pk"), measured_at__gte=cutoff
            )
            absent = Interface.objects.filter(present=False).exclude(Exists(remaining))
            self.stdout.write(
                f"Would delete {samples.count()} interface sample(s), {polls.count()} "
                f"poll(s) and {absent.count()} absent interface(s) older than {cutoff.isoformat()}."
            )
            return

        deleted_samples, sample_batches = delete_in_batches(samples, batch_size=batch_size)
        deleted_polls, poll_batches = delete_in_batches(polls, batch_size=batch_size)
        # Interfaces are removed last: they cannot be deleted while samples exist.
        orphaned = Interface.objects.filter(present=False).exclude(
            Exists(InterfaceSample.objects.filter(interface=OuterRef("pk")))
        )
        deleted_interfaces, _ = delete_in_batches(orphaned, batch_size=batch_size)
        self.stdout.write(
            self.style.SUCCESS(
                f"Deleted {deleted_samples} interface sample(s) in {sample_batches} batch(es), "
                f"{deleted_polls} poll(s) in {poll_batches} batch(es) and "
                f"{deleted_interfaces} absent interface(s) older than {cutoff.isoformat()}."
            )
        )
