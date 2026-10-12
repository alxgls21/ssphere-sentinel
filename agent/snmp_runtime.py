"""Wire SNMP configuration, collector, scheduler, queue and delivery together.

SNMP monitoring is optional at every level. Nothing here changes how an agent
without it behaves:

* no ``SENTINEL_SNMP_DEVICES_FILE``: no runtime (unless polls from an earlier
  configuration are still queued: those are still delivered);
* a configuration error, or the ``[snmp]`` extra missing: logged once, SNMP
  stays off, heartbeats, telemetry, Docker and network monitoring continue.

The queue is the network runtime's when there is one (one SQLite file, one
connection), else the runtime opens it itself.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from typing import Any

from agent.errors import ConfigError
from agent.measurement_queue import MeasurementQueue, QueueError
from agent.network_runtime import bounded_int, load_runtime_config
from agent.snmp_collector import DevicePoller
from agent.snmp_config import (
    VERSION_2C,
    SnmpConfig,
    SnmpCredential,
    load_snmp_config,
)
from agent.snmp_delivery import SnmpDelivery
from agent.snmp_fetch import (
    Fetcher,
    PysnmpFetcher,
    SnmpUnavailableError,
    check_snmp_available,
)
from agent.snmp_scheduler import (
    DEFAULT_MAX_CONCURRENT_POLLS,
    MAX_CONCURRENT_POLLS,
    SnmpScheduler,
)

logger = logging.getLogger("sentinel_agent")

ENV_MAX_CONCURRENT_POLLS = "SENTINEL_SNMP_MAX_CONCURRENT_POLLS"
SHUTDOWN_TIMEOUT_SECONDS = 10.0
_DEFAULT_COMMUNITIES = frozenset({"public", "private"})


class SnmpRuntime:
    """SNMP monitoring for one agent process: polls -> queue -> heartbeat."""

    def __init__(
        self,
        queue: MeasurementQueue,
        pollers: list[DevicePoller] | None = None,
        *,
        max_concurrent_polls: int = DEFAULT_MAX_CONCURRENT_POLLS,
        owns_queue: bool = False,
    ) -> None:
        self.queue = queue
        self.pollers = list(pollers or [])
        self.delivery = SnmpDelivery(queue)
        self.scheduler = SnmpScheduler(
            self.pollers, sink=self.enqueue, max_workers=max_concurrent_polls
        )
        self._owns_queue = owns_queue

    @classmethod
    def from_environment(
        cls,
        environ: Mapping[str, str] | None = None,
        *,
        queue: MeasurementQueue | None = None,
        fetcher: Fetcher | None = None,
    ) -> SnmpRuntime | None:
        """Build the runtime, or return ``None`` when there is nothing to do.

        Nothing to do means: no usable enabled device and no queued SNMP polls
        to deliver. ``queue`` is the network runtime's queue, if there is one.
        """
        env = dict(environ) if environ is not None else dict(os.environ)
        config = _load_config(env)
        pollers: list[DevicePoller] = []
        if config is not None and config.enabled_devices:
            pollers = _build_pollers(config, fetcher)

        owns_queue = False
        if queue is None:
            runtime_config = load_runtime_config(env)
            has_backlog = runtime_config.queue_path is not None and runtime_config.queue_path.exists()
            if not pollers and not has_backlog:
                return None
            queue = MeasurementQueue.open(
                runtime_config.queue_path,
                max_measurements=runtime_config.max_measurements,
                max_age_seconds=runtime_config.max_age_seconds,
                max_snmp_polls=runtime_config.max_snmp_polls,
                max_snmp_bytes=runtime_config.max_snmp_bytes,
            )
            owns_queue = True
        if not pollers and _backlog(queue) == 0:
            if owns_queue:
                queue.close()
            return None
        return cls(
            queue,
            pollers,
            max_concurrent_polls=bounded_int(
                env,
                ENV_MAX_CONCURRENT_POLLS,
                DEFAULT_MAX_CONCURRENT_POLLS,
                1,
                MAX_CONCURRENT_POLLS,
            ),
            owns_queue=owns_queue,
        )

    def enqueue(self, poll: dict[str, Any]) -> None:
        try:
            self.queue.enqueue_snmp(poll)
        except QueueError as exc:
            logger.warning(
                "SNMP poll %s could not be queued and is lost: %s", poll.get("poll_id"), exc
            )

    def start(self) -> None:
        self.scheduler.start()

    def poll_once(self, timeout: float | None = None) -> int:
        return self.scheduler.run_once(timeout)

    def stop(self, timeout: float = SHUTDOWN_TIMEOUT_SECONDS) -> None:
        try:
            self.scheduler.stop(timeout)
        finally:
            if self._owns_queue:
                self.queue.close()


def _load_config(env: dict[str, str]) -> SnmpConfig | None:
    try:
        return load_snmp_config(env)
    except ConfigError as exc:
        # Never stop heartbeats over a configuration mistake.
        logger.warning("SNMP monitoring disabled: %s", exc)
        return None


def _build_pollers(config: SnmpConfig, fetcher: Fetcher | None) -> list[DevicePoller]:
    used = {device.credential_profile for device in config.enabled_devices}
    credentials = [config.credentials[name] for name in sorted(used)]
    try:
        check_snmp_available(credentials)
    except SnmpUnavailableError as exc:
        logger.warning("SNMP monitoring disabled: %s", exc)
        return []
    _warn_about_credentials(credentials)
    shared = fetcher or PysnmpFetcher()
    return [
        DevicePoller(device, config.credentials[device.credential_profile], shared)
        for device in config.enabled_devices
    ]


def _warn_about_credentials(credentials: list[SnmpCredential]) -> None:
    """One line per weak profile; the secrets themselves are never logged."""
    for credential in credentials:
        if credential.version == VERSION_2C:
            logger.warning(
                "SNMP profile %s uses SNMPv2c: the community string is sent in clear text; "
                "prefer SNMPv3 with authentication and privacy",
                credential.name,
            )
            if credential.community in _DEFAULT_COMMUNITIES:
                logger.warning(
                    "SNMP profile %s uses a default community string; change it on the device",
                    credential.name,
                )
        elif not credential.priv_protocol:
            logger.warning(
                "SNMP profile %s uses SNMPv3 without privacy (authNoPriv): "
                "polls are authenticated but not encrypted",
                credential.name,
            )
        elif credential.auth_protocol == "SHA":
            logger.warning(
                "SNMP profile %s authenticates with SHA-1; use SHA-256 or stronger if the device supports it",
                credential.name,
            )


def _backlog(queue: MeasurementQueue) -> int:
    try:
        return queue.snmp_count()
    except QueueError as exc:
        logger.warning("SNMP queue unavailable: %s", exc)
        return 0
