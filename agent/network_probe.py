"""ICMP/TCP network probes without shell interpolation."""

from __future__ import annotations

import platform
import socket
import subprocess
import threading
import time
from dataclasses import dataclass
from shutil import which

from agent.network_config import NetworkTargetConfig, validate_hostname_or_ip

FAILURE_TIMEOUT = "timeout"
FAILURE_CONNECTION_REFUSED = "connection_refused"
FAILURE_HOST_UNREACHABLE = "host_unreachable"
FAILURE_DNS_FAILURE = "dns_failure"
FAILURE_PERMISSION_DENIED = "permission_denied"
FAILURE_UNSUPPORTED = "unsupported"
FAILURE_NETWORK_ERROR = "network_error"
FAILURE_UNKNOWN = "unknown"


@dataclass(frozen=True)
class ProbeAttempt:
    success: bool
    latency_ms: float | None
    failure_reason: str


@dataclass(frozen=True)
class ProbeResult:
    success: bool
    latency_ms: float | None
    packet_loss_percentage: float
    probe_count: int
    successful_probes: int
    failure_reason: str


class ProbeCancelled(Exception):
    """Raised when a multi-attempt probe is interrupted by shutdown."""


def probe_target(
    target: NetworkTargetConfig,
    *,
    stop_event: threading.Event | None = None,
) -> ProbeResult:
    """Run multiple probe attempts and aggregate latency / packet loss.

    If ``stop_event`` is set between attempts the probe is abandoned with
    ``ProbeCancelled`` (a partial result would misstate packet loss).
    """
    host = validate_hostname_or_ip(target.hostname_or_ip)
    attempts: list[ProbeAttempt] = []

    for _ in range(target.probe_count):
        if stop_event is not None and stop_event.is_set():
            raise ProbeCancelled()
        if target.protocol == "tcp":
            assert target.port is not None
            attempts.append(
                probe_tcp(host, target.port, timeout_seconds=target.timeout_seconds)
            )
        else:
            attempts.append(
                probe_icmp(host, timeout_seconds=target.timeout_seconds)
            )

    successes = [attempt for attempt in attempts if attempt.success]
    successful_probes = len(successes)
    packet_loss = round(
        ((target.probe_count - successful_probes) / target.probe_count) * 100.0,
        2,
    )
    if successes:
        latency = round(
            sum(attempt.latency_ms for attempt in successes if attempt.latency_ms is not None)
            / len(successes),
            3,
        )
        return ProbeResult(
            success=True,
            latency_ms=latency,
            packet_loss_percentage=packet_loss,
            probe_count=target.probe_count,
            successful_probes=successful_probes,
            failure_reason="",
        )

    # Prefer the most specific failure among attempts.
    reason = _pick_failure_reason([attempt.failure_reason for attempt in attempts])
    return ProbeResult(
        success=False,
        latency_ms=None,
        packet_loss_percentage=100.0,
        probe_count=target.probe_count,
        successful_probes=0,
        failure_reason=reason,
    )


def probe_tcp(host: str, port: int, *, timeout_seconds: float) -> ProbeAttempt:
    host = validate_hostname_or_ip(host)
    started = time.perf_counter()
    try:
        with socket.create_connection((host, port), timeout=timeout_seconds):
            latency_ms = (time.perf_counter() - started) * 1000.0
            return ProbeAttempt(
                success=True,
                latency_ms=round(latency_ms, 3),
                failure_reason="",
            )
    except socket.timeout:
        return ProbeAttempt(False, None, FAILURE_TIMEOUT)
    except ConnectionRefusedError:
        return ProbeAttempt(False, None, FAILURE_CONNECTION_REFUSED)
    except socket.gaierror:
        return ProbeAttempt(False, None, FAILURE_DNS_FAILURE)
    except OSError as exc:
        errno = getattr(exc, "errno", None)
        # Host unreachable / network unreachable common errno values.
        if errno in {64, 65, 101, 113}:  # EHOSTDOWN/EHOSTUNREACH variants
            return ProbeAttempt(False, None, FAILURE_HOST_UNREACHABLE)
        return ProbeAttempt(False, None, FAILURE_NETWORK_ERROR)


def probe_icmp(host: str, *, timeout_seconds: float) -> ProbeAttempt:
    """ICMP via system ping executable (argv only, never shell=True)."""
    host = validate_hostname_or_ip(host)
    ping_path = which("ping")
    if not ping_path:
        return ProbeAttempt(False, None, FAILURE_UNSUPPORTED)

    system = platform.system().lower()
    if system == "darwin":
        # macOS: -W timeout is milliseconds.
        timeout_ms = max(1, int(timeout_seconds * 1000))
        args = [ping_path, "-c", "1", "-W", str(timeout_ms), host]
    else:
        # Linux: -W timeout is seconds (integer).
        timeout_s = max(1, int(timeout_seconds))
        args = [ping_path, "-c", "1", "-W", str(timeout_s), host]

    started = time.perf_counter()
    try:
        completed = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout_seconds + 2,
            check=False,
            shell=False,
        )
    except subprocess.TimeoutExpired:
        return ProbeAttempt(False, None, FAILURE_TIMEOUT)
    except PermissionError:
        return ProbeAttempt(False, None, FAILURE_PERMISSION_DENIED)
    except FileNotFoundError:
        return ProbeAttempt(False, None, FAILURE_UNSUPPORTED)
    except OSError:
        return ProbeAttempt(False, None, FAILURE_NETWORK_ERROR)

    output = (completed.stdout or "") + (completed.stderr or "")
    lowered = output.lower()
    if completed.returncode == 0:
        latency_ms = (time.perf_counter() - started) * 1000.0
        parsed = _parse_ping_latency_ms(output)
        return ProbeAttempt(
            success=True,
            latency_ms=round(parsed if parsed is not None else latency_ms, 3),
            failure_reason="",
        )

    if "permission denied" in lowered or "operation not permitted" in lowered:
        return ProbeAttempt(False, None, FAILURE_PERMISSION_DENIED)
    if "unknown host" in lowered or "name or service not known" in lowered:
        return ProbeAttempt(False, None, FAILURE_DNS_FAILURE)
    if "timed out" in lowered or "100% packet loss" in lowered:
        return ProbeAttempt(False, None, FAILURE_TIMEOUT)
    if "unreachable" in lowered:
        return ProbeAttempt(False, None, FAILURE_HOST_UNREACHABLE)
    return ProbeAttempt(False, None, FAILURE_UNKNOWN)


def _parse_ping_latency_ms(output: str) -> float | None:
    # Look for patterns like time=12.3 ms
    import re

    match = re.search(r"time[=<]([0-9]+(?:\.[0-9]+)?)\s*ms", output, re.IGNORECASE)
    if not match:
        return None
    return float(match.group(1))


def _pick_failure_reason(reasons: list[str]) -> str:
    priority = [
        FAILURE_PERMISSION_DENIED,
        FAILURE_UNSUPPORTED,
        FAILURE_DNS_FAILURE,
        FAILURE_CONNECTION_REFUSED,
        FAILURE_HOST_UNREACHABLE,
        FAILURE_TIMEOUT,
        FAILURE_NETWORK_ERROR,
        FAILURE_UNKNOWN,
    ]
    for candidate in priority:
        if candidate in reasons:
            return candidate
    return FAILURE_UNKNOWN
