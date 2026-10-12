"""Network measurement payload format shared by the probe scheduler and delivery."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from agent.network_config import NetworkTargetConfig
from agent.network_probe import ProbeResult

NETWORK_PAYLOAD_VERSION = 1


def build_measurement(
    target: NetworkTargetConfig,
    result: ProbeResult,
) -> dict[str, Any]:
    """Build one measurement with a new, stable ``measurement_id``.

    The ID is generated once per probe and reused on every resend so the
    server can deduplicate retries.
    """
    return {
        "measurement_id": str(uuid.uuid4()),
        "target_id": str(target.id),
        "measured_at": datetime.now(timezone.utc).isoformat(),
        "success": result.success,
        "latency_ms": result.latency_ms,
        "packet_loss_percentage": result.packet_loss_percentage,
        "probe_count": result.probe_count,
        "successful_probes": result.successful_probes,
        "failure_reason": result.failure_reason,
    }
