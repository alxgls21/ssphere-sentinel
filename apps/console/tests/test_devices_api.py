"""SNMP devices: ``/devices/``, ``/devices/<id>/``, ``/devices/<id>/series/`` and the interface series
(``apps.console.devices``).

Device and interface health, stale polls and silent agents, the rates and why a
sample gives none, completed buckets and gaps, access and scope, query bounds,
and the shape of every response.
"""

from __future__ import annotations

import itertools
import uuid
from datetime import datetime, timedelta, timezone as dt_timezone

from django.db import connection
from django.test.utils import CaptureQueriesContext

from apps.agents.services import create_agent
from apps.console.devices import sample_rates
from apps.console.tests.helpers import API, ConsoleDataTestCase, make_server, make_user, signed_in_client
from apps.inventory.models import Customer, Device, Site
from apps.snmp.models import DevicePoll, DeviceSnmpState, Interface, InterfaceSample, SnmpConfig

GBIT = 1_000_000_000
_index = itertools.count(1)


class DeviceTestCase(ConsoleDataTestCase):
    def setUp(self):
        super().setUp()
        self.acme = Customer.objects.create(name="Acme")
        self.globex = Customer.objects.create(name="Globex")
        self.hq = Site.objects.create(customer=self.acme, name="HQ")
        self.plant = Site.objects.create(customer=self.globex, name="Plant")
        self.server = make_server("poller-host", site=self.hq, now=self.now)
        self.agent, self.token = create_agent(server=self.server, name="poller")
        self.seen(self.agent, 5)
        self.admin = make_user("ops", all_customers=True)

    def seen(self, agent, ago):
        agent.last_seen_at = None if ago is None else self.now - timedelta(seconds=ago)
        agent.save(update_fields=["last_seen_at"])

    def device(self, name="core-sw", *, site="hq", agent="default", interval=300, polled=10, reachable=True,
               configured=True, **fields):
        device = Device.objects.create(
            name=name, management_address="192.0.2.10", site={"hq": self.hq, "plant": self.plant, None: None}[site],
            assigned_agent=self.agent if agent == "default" else agent, **fields,
        )
        if configured:
            SnmpConfig.objects.create(device=device, credential_profile="secret-profile-name", poll_interval_seconds=interval,
                                      timeout_seconds=5, retries=1)
        if polled is not None:
            at = self.now - timedelta(seconds=polled)
            DeviceSnmpState.objects.create(
                device=device, last_poll_at=at, last_success_at=at if reachable else None, received_at=at + timedelta(seconds=1),
                reachable=reachable, error="" if reachable else "timeout", response_ms=12.5 if reachable else None,
                sys_uptime_ticks=123_456_00, sys_name=f"{name}.example", sys_descr="Switch OS 1.0", sys_object_id="1.3.6.1.4.1.9",
            )
        return device

    def interface(self, device, if_index=None, *, admin=1, oper=1, speed=GBIT, present=True, name=None):
        if_index = if_index or next(_index)
        return Interface.objects.create(
            device=device, if_index=if_index, name=name or f"Gi0/{if_index}", descr="GigabitEthernet", alias="uplink",
            if_type=6, speed_bps=speed, admin_status=admin, oper_status=oper, present=present,
        )

    def sample(self, interface, ago, *, state="ok", interval=300.0, in_octets=37_500_000, out_octets=75_000_000,
               errors=3, discards=6, speed=GBIT, bits=64):
        valid = state in ("ok", "speed_changed")
        delta = (lambda v: v) if valid else (lambda v: None)
        return InterfaceSample.objects.create(
            interface=interface, measured_at=self.now - timedelta(seconds=ago),
            interval_seconds=interval if valid else None, admin_status=1, oper_status=1, speed_bps=speed, octets_bits=bits,
            delta_state=state, in_octets=1, out_octets=1, in_errors=1, out_errors=1, in_discards=1, out_discards=1,
            in_octets_delta=delta(in_octets), out_octets_delta=delta(out_octets), in_errors_delta=delta(errors),
            out_errors_delta=delta(errors), in_discards_delta=delta(discards), out_discards_delta=delta(discards),
        )

    def poll(self, device, ago, reachable=True, response=10.0):
        return DevicePoll.objects.create(
            id=uuid.uuid4(), device=device, measured_at=self.now - timedelta(seconds=ago), received_at=self.now,
            reachable=reachable, response_ms=response if reachable else None, error="" if reachable else "timeout",
        )

    def detail(self, device, user=None):
        response = self.get(user or self.admin, f"devices/{device.pk}/")
        self.assertEqual(response.status_code, 200, response.content[:300])
        return response.json()

    def listed(self, user=None, **params):
        response = self.get(user or self.admin, "devices/", **params)
        self.assertEqual(response.status_code, 200, response.content[:300])
        return response.json()


def iso(value: datetime) -> str:
    return value.astimezone(dt_timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class DeviceHealthTests(DeviceTestCase):
    def status(self, device):
        item = self.detail(device)["item"]
        return item["health"], item["reason"], item["stale"]

    def test_the_rules_in_their_order(self):
        silent = create_agent(server=make_server("silent-host", site=self.hq, now=self.now), name="silent")[0]
        self.seen(silent, 200)
        never = create_agent(server=make_server("never-host", site=self.hq, now=self.now), name="never")[0]
        self.seen(never, None)
        off = create_agent(server=make_server("off-host", site=self.hq, now=self.now), name="off")[0]
        self.seen(off, 5)
        off.enabled = False
        off.save(update_fields=["enabled"])
        cases = (
            (self.device("disabled", enabled=False, reachable=False), ("idle", "disabled", False)),
            (self.device("no-agent", agent=None), ("unknown", "no_agent", False)),
            (self.device("agent-silent", agent=silent, reachable=False), ("unknown", "agent_offline", False)),
            (self.device("agent-never", agent=never), ("unknown", "agent_offline", False)),
            (self.device("agent-disabled", agent=off), ("unknown", "agent_offline", False)),
            (self.device("never-polled", polled=None), ("unknown", "no_poll", False)),
            # Stale before unreachable: an old failed poll is unknown, not critical.
            (self.device("stale-unreachable", polled=1000, reachable=False), ("unknown", "stale", True)),
            (self.device("unreachable", reachable=False), ("critical", "unreachable", False)),
            (self.device("ok"), ("healthy", "ok", False)),
        )
        for device, expected in cases:
            with self.subTest(device.name):
                self.assertEqual(self.status(device), expected)

    def test_a_poll_is_current_for_three_intervals_and_at_least_the_offline_threshold(self):
        for interval, ago, stale in ((300, 899, False), (300, 901, True), (30, 89, False), (30, 91, True)):
            with self.subTest(interval=interval, ago=ago):
                device = self.device(f"d-{interval}-{ago}", interval=interval, polled=ago)
                self.assertEqual(self.status(device)[2], stale)

    def test_freshness_is_the_poll_time_not_the_delivery(self):
        device = self.device(polled=3600)
        DeviceSnmpState.objects.filter(device=device).update(received_at=self.now)
        self.assertEqual(self.status(device), ("unknown", "stale", True))

    def test_interfaces_down_do_not_make_the_device_unhealthy(self):
        device = self.device()
        self.interface(device, oper=2)
        self.interface(device, oper=7)
        self.assertEqual(self.status(device), ("healthy", "ok", False))

    def test_a_device_without_an_snmp_configuration_is_not_an_snmp_device(self):
        device = self.device("plain", configured=False, polled=None)
        self.assertEqual(self.listed()["scopeTotal"], 0)
        self.assertEqual(self.get(self.admin, f"devices/{device.pk}/").status_code, 404)


class InterfaceHealthTests(DeviceTestCase):
    def health(self, device):
        return {i["name"]: (i["health"], i["reason"]) for i in self.detail(device)["interfaces"]}

    def test_the_rules(self):
        device = self.device()
        self.interface(device, 1, name="up")
        self.interface(device, 2, admin=2, oper=2, name="admin-down")
        self.interface(device, 3, oper=2, name="down")
        self.interface(device, 4, oper=7, name="lower-layer-down")
        self.interface(device, 5, oper=5, name="dormant")
        self.interface(device, 6, oper=6, name="not-present")
        self.interface(device, 7, admin=3, oper=3, name="testing")
        self.interface(device, 8, present=False, name="absent")
        self.assertEqual(
            self.health(device),
            {
                "up": ("healthy", "up"), "admin-down": ("idle", "admin_down"), "down": ("warning", "down"),
                "lower-layer-down": ("warning", "down"), "dormant": ("unknown", "other"),
                "not-present": ("unknown", "other"), "testing": ("unknown", "other"),
            },  # absent interfaces are not served
        )
        counts = self.detail(device)["item"]["interfaces"]
        self.assertEqual(counts, {"total": 7, "counts": {"critical": 0, "warning": 2, "unknown": 3, "idle": 1, "healthy": 1}})

    def test_on_a_device_that_is_not_current_every_interface_is_unknown(self):
        for name, kwargs in (("unreachable", {"reachable": False}), ("stale", {"polled": 5000}), ("disabled", {"enabled": False})):
            with self.subTest(name):
                device = self.device(name, **kwargs)
                self.interface(device, 1)
                self.interface(device, 2, oper=2)
                self.assertEqual(set(self.health(device).values()), {("unknown", "device_unavailable")})
                self.assertEqual(self.detail(device)["item"]["interfaces"]["counts"]["unknown"], 2)


class RateTests(DeviceTestCase):
    def rates(self, device, interface):
        return next(i for i in self.detail(device)["interfaces"] if i["ifIndex"] == interface.if_index)["rates"]

    def test_bps_utilization_and_per_second_rates_of_a_valid_sample(self):
        device = self.device()
        iface = self.interface(device)
        self.sample(iface, 30, in_octets=37_500_000, out_octets=75_000_000, errors=3, discards=6, interval=300.0)
        rates = self.rates(device, iface)
        self.assertEqual(
            rates,
            {
                "measuredAt": iso(self.now - timedelta(seconds=30)), "deltaState": "ok", "octetsBits": 64, "intervalSeconds": 300.0,
                "valid": True, "invalidReason": None,
                "inBps": 1_000_000.0, "outBps": 2_000_000.0, "inUtilizationPercent": 0.1, "outUtilizationPercent": 0.2,
                "inErrorsPerSec": 0.01, "outErrorsPerSec": 0.01, "inDiscardsPerSec": 0.02, "outDiscardsPerSec": 0.02,
            },
        )

    def test_the_latest_sample_is_the_one_judged(self):
        device = self.device()
        iface = self.interface(device)
        self.sample(iface, 330)
        self.sample(iface, 30, state="reset")
        rates = self.rates(device, iface)
        self.assertEqual((rates["valid"], rates["invalidReason"], rates["deltaState"]), (False, "delta_state", "reset"))
        self.assertEqual({k: rates[k] for k in ("inBps", "outBps", "inErrorsPerSec")}, dict.fromkeys(("inBps", "outBps", "inErrorsPerSec")))

    def test_counter_anomalies_give_no_rates_never_zero(self):
        for state in ("first", "reboot", "reset", "gap"):
            with self.subTest(state):
                device = self.device(f"d-{state}")
                iface = self.interface(device)
                self.sample(iface, 30, state=state)
                rates = self.rates(device, iface)
                self.assertEqual((rates["valid"], rates["invalidReason"]), (False, "delta_state"))
                self.assertTrue(all(rates[k] is None for k in ("inBps", "outBps", "inUtilizationPercent", "inDiscardsPerSec")))

    def test_a_speed_change_keeps_valid_rates(self):
        device = self.device()
        iface = self.interface(device)
        self.sample(iface, 30, state="speed_changed")
        self.assertTrue(self.rates(device, iface)["valid"])

    def test_implausible_rates_are_rejected_at_one_and_a_half_times_the_speed(self):
        device = self.device()
        at_limit = self.interface(device, 1, speed=10_000_000)
        above = self.interface(device, 2, speed=10_000_000)
        # 15 Mbit/s on a 10 Mbit/s link: 562,500,000 octets in 300 s.
        # Each sample is judged by the speed it reported.
        self.sample(at_limit, 30, in_octets=562_500_000, out_octets=0, speed=10_000_000)
        self.sample(above, 30, in_octets=562_500_001, out_octets=0, speed=10_000_000)
        self.assertEqual(self.rates(device, at_limit)["inBps"], 15_000_000.0)
        rates = self.rates(device, above)
        self.assertEqual((rates["valid"], rates["invalidReason"], rates["inBps"]), (False, "implausible", None))

    def test_an_unknown_speed_gives_no_utilization_but_keeps_the_bps(self):
        device = self.device()
        iface = self.interface(device, speed=None)
        self.sample(iface, 30, speed=None, in_octets=10**15)
        rates = self.rates(device, iface)
        self.assertEqual((rates["valid"], rates["inUtilizationPercent"], rates["outUtilizationPercent"]), (True, None, None))
        self.assertEqual(rates["inBps"], 10**15 * 8 / 300)

    def test_a_stale_latest_sample_gives_no_current_rates(self):
        device = self.device(polled=10)
        iface = self.interface(device)
        self.sample(iface, 3000)
        rates = self.rates(device, iface)
        self.assertEqual((rates["valid"], rates["invalidReason"], rates["inBps"]), (False, "stale", None))

    def test_a_missing_counter_leaves_that_rate_null_and_the_rest_valid(self):
        device = self.device()
        iface = self.interface(device)
        sample = self.sample(iface, 30)
        InterfaceSample.objects.filter(pk=sample.pk).update(in_errors=None, in_errors_delta=None)
        rates = self.rates(device, iface)
        self.assertEqual((rates["valid"], rates["inErrorsPerSec"], rates["outErrorsPerSec"]), (True, None, 0.01))

    def test_an_interface_never_sampled_has_no_rates(self):
        device = self.device()
        iface = self.interface(device)
        self.assertIsNone(self.rates(device, iface))

    def test_a_sample_without_a_positive_interval_is_rejected(self):
        base = {"measured_at": self.now, "speed_bps": GBIT, "octets_bits": 64, "delta_state": "ok",
                **{f"{d}_{c}_delta": 1 for d in ("in", "out") for c in ("octets", "errors", "discards")}}
        for interval in (None, 0, -5.0):
            with self.subTest(interval):
                rates = sample_rates({**base, "interval_seconds": interval})
                self.assertEqual((rates["valid"], rates["invalidReason"], rates["inBps"]), (False, "interval", None))


class SeriesTests(DeviceTestCase):
    def at(self, body, from_end, key):
        return body[key][len(body[key]) - from_end]

    def put_time(self, step, from_end, offset):
        current = int(self.now.timestamp()) // step * step
        measured = datetime.fromtimestamp(current - from_end * step + offset, tz=dt_timezone.utc)
        return (self.now - measured).total_seconds()

    def test_the_device_series(self):
        device = self.device(interval=60)
        self.poll(device, self.put_time(60, 1, 5), response=10.0)
        self.poll(device, self.put_time(60, 1, 35), response=30.0)
        self.poll(device, self.put_time(60, 2, 10), reachable=False)
        self.poll(device, self.put_time(60, 0, 1), response=999.0)  # the bucket in progress
        body = self.get(self.admin, f"devices/{device.pk}/series/", range="1h").json()
        self.assertEqual((body["bucketMs"], len(body["t"])), (60_000, 60))
        self.assertEqual([self.at(body, 1, k) for k in ("responseMs", "reachablePolls", "failedPolls")], [20.0, 2, 0])
        self.assertEqual([self.at(body, 2, k) for k in ("responseMs", "reachablePolls", "failedPolls")], [None, 0, 1])
        self.assertEqual([self.at(body, 3, k) for k in ("responseMs", "reachablePolls", "failedPolls")], [None, 0, 0])
        self.assertNotIn(999.0, body["responseMs"])

    def test_the_interface_series_judges_each_sample_by_itself(self):
        # The device went stale long ago, but its samples of the last hour were valid then and are served.
        device = self.device(interval=60, polled=1200)
        iface = self.interface(device, 3)
        self.sample(iface, self.put_time(60, 1, 5), interval=60.0, in_octets=750_000, out_octets=0)  # 100 kbit/s
        self.sample(iface, self.put_time(60, 1, 35), interval=60.0, in_octets=2_250_000, out_octets=0)  # 300 kbit/s
        self.sample(iface, self.put_time(60, 2, 10), state="reboot")
        self.sample(iface, self.put_time(60, 3, 10), interval=60.0, in_octets=10**12, speed=GBIT)  # implausible
        body = self.get(self.admin, f"devices/{device.pk}/interfaces/3/series/", range="1h").json()
        self.assertEqual(len(body["t"]), 60)
        self.assertEqual([self.at(body, 1, k) for k in ("inBps", "inBpsMax", "validSamples", "invalidSamples")],
                         [200_000.0, 300_000.0, 2, 0])
        self.assertEqual([self.at(body, 2, k) for k in ("inBps", "validSamples", "invalidSamples")], [None, 0, 1])
        self.assertEqual([self.at(body, 3, k) for k in ("inBps", "validSamples", "invalidSamples")], [None, 0, 1])
        self.assertEqual([self.at(body, 4, k) for k in ("inBps", "validSamples", "invalidSamples")], [None, 0, 0])
        self.assertEqual(self.at(body, 1, "inErrorsPerSec"), 0.05)

    def test_the_bucket_is_never_shorter_than_the_poll_interval_and_never_polled_is_empty(self):
        device = self.device(interval=300)
        iface = self.interface(device, 1)
        self.poll(device, 400)
        body = self.get(self.admin, f"devices/{device.pk}/series/", range="1h").json()
        self.assertEqual((body["bucketMs"], len(body["t"])), (300_000, 12))
        body = self.get(self.admin, f"devices/{device.pk}/interfaces/1/series/", range="15m").json()
        self.assertEqual((body["bucketMs"], body["t"], body["inBps"], body["validSamples"]), (300_000, [], [], []))
        fresh = self.device("fresh", polled=None)
        body = self.get(self.admin, f"devices/{fresh.pk}/series/").json()
        self.assertEqual((body["t"], body["responseMs"], body["failedPolls"]), ([], [], []))
        self.assertEqual(iface.if_index, 1)

    def test_unknown_interfaces_and_ranges(self):
        device = self.device()
        self.assertEqual(self.get(self.admin, f"devices/{device.pk}/interfaces/99/series/").status_code, 404)
        self.interface(device, 1)
        self.assertEqual(self.get(self.admin, f"devices/{device.pk}/interfaces/1/series/", range="7d").status_code, 400)
        self.assertEqual(self.get(self.admin, f"devices/{device.pk}/series/", range="2h").status_code, 400)


class AccessTests(DeviceTestCase):
    def setUp(self):
        super().setUp()
        self.d_hq = self.device("d-hq")
        self.d_plant = self.device("d-plant", site="plant")
        self.d_none = self.device("d-none", site=None)
        for device in (self.d_hq, self.d_plant, self.d_none):
            iface = self.interface(device, 1)
            self.sample(iface, 30)
            self.poll(device, 30)

    def names(self, response):
        self.assertEqual(response.status_code, 200, response.content[:300])
        return sorted(item["device"]["name"] for item in response.json()["items"])

    def paths(self, device):
        return (f"devices/{device.pk}/", f"devices/{device.pk}/series/", f"devices/{device.pk}/interfaces/1/series/")

    def test_signed_out_and_without_console_access(self):
        plain = signed_in_client(make_user("plain", console=False))
        for path in ("devices/", *self.paths(self.d_hq)):
            with self.subTest(path):
                self.assertEqual(self.client.get(API + path).status_code, 401)
                self.assertEqual(plain.get(API + path).status_code, 403)

    def test_each_user_sees_the_devices_of_their_sites_only(self):
        acme = make_user("acme", customers=[self.acme])
        plant = make_user("plant", sites=[self.plant])
        self.assertEqual(self.names(self.get(self.admin, "devices/")), ["d-hq", "d-none", "d-plant"])
        self.assertEqual(self.names(self.get(acme, "devices/")), ["d-hq"])
        self.assertEqual(self.names(self.get(plant, "devices/")), ["d-plant"])
        self.assertEqual(self.names(self.get(self.admin, "devices/", site=str(self.plant.pk))), ["d-plant"])
        self.assertEqual(self.get(acme, "devices/", site=str(self.plant.pk)).status_code, 404)

    def test_a_hidden_device_is_not_found_like_one_that_does_not_exist(self):
        acme = make_user("acme", customers=[self.acme])
        for device in (self.d_plant, self.d_none):
            for path in self.paths(device):
                with self.subTest(path):
                    response = self.get(acme, path)
                    self.assertEqual((response.status_code, response.json()["error"]["code"]), (404, "not_found"))
        self.assertEqual(self.get(acme, f"devices/{uuid.uuid4()}/").status_code, 404)

    def test_the_agent_is_shown_only_when_its_server_is_visible(self):
        plant = make_user("plant", sites=[self.plant])
        item = self.detail(self.d_plant, plant)["item"]
        self.assertEqual((item["device"]["agentAssigned"], item["device"]["agent"]), (True, None))
        self.assertEqual(self.detail(self.d_plant)["item"]["device"]["agent"]["serverName"], "poller-host")

    def test_no_credential_or_secret_is_read_or_sent(self):
        client = signed_in_client(self.admin)
        client.get(API + "devices/")
        with CaptureQueriesContext(connection) as queries:
            bodies = [client.get(API + path).content.decode() for path in ("devices/", *self.paths(self.d_hq))]
        for query in queries:
            self.assertNotIn("credential_profile", query["sql"])
            self.assertNotIn("token_hash", query["sql"])
        for body in bodies:
            for secret in ("secret-profile-name", "credential", self.token, self.agent.token_hash):
                self.assertNotIn(secret, body)

    def test_every_snmp_query_of_a_restricted_user_is_filtered_by_site(self):
        client = signed_in_client(make_user("acme", customers=[self.acme]))
        for path in ("devices/", *self.paths(self.d_hq)):
            client.get(API + path)
            with self.subTest(path), CaptureQueriesContext(connection) as queries:
                self.assertEqual(client.get(API + path).status_code, 200)
            touching = [q["sql"] for q in queries if "snmp_" in q["sql"] or "inventory_device" in q["sql"]]
            self.assertTrue(touching)
            for sql in touching:
                self.assertIn('"site_id" IN', sql, sql[:400])


class ListTests(DeviceTestCase):
    def setUp(self):
        super().setUp()
        self.device("Alpha")
        DeviceSnmpState.objects.filter(device__name="Alpha").update(response_ms=40.0)
        self.device("bravo")
        DeviceSnmpState.objects.filter(device__name="bravo").update(response_ms=5.0)
        self.device("charlie", reachable=False)
        self.device("delta", polled=5000)
        self.device("echo", enabled=False)
        self.device("foxtrot", polled=None)

    def names(self, **params):
        return [item["device"]["name"] for item in self.listed(**params)["items"]]

    def test_sorts_filters_counts_and_pages(self):
        self.assertEqual(self.names(), ["charlie", "delta", "foxtrot", "echo", "Alpha", "bravo"])
        self.assertEqual(self.names(sort="response"), ["Alpha", "bravo", "charlie", "delta", "echo", "foxtrot"])
        self.assertEqual(self.names(sort="response", dir="asc")[:2], ["bravo", "Alpha"])
        self.assertEqual(self.names(sort="polled")[0], "delta")
        self.assertEqual(self.names(sort="polled")[-1], "foxtrot")
        body = self.listed(status="unknown")
        self.assertEqual(sorted(i["device"]["name"] for i in body["items"]), ["delta", "foxtrot"])
        self.assertEqual(body["counts"], {"critical": 1, "warning": 0, "unknown": 2, "idle": 1, "healthy": 2})
        self.assertEqual((body["page"]["total"], body["scopeTotal"]), (2, 6))
        body = self.listed(q="charlie.example")  # sysName
        self.assertEqual(([i["device"]["name"] for i in body["items"]], body["scopeTotal"]), (["charlie"], 6))
        body = self.listed(sort="name", pageSize=4, page=2)
        self.assertEqual(([i["device"]["name"] for i in body["items"]], body["page"]), (["echo", "foxtrot"], {"number": 2, "size": 4, "total": 6, "pages": 2}))

    def test_invalid_queries(self):
        for params in ({"sort": "traffic"}, {"status": "ok"}, {"dir": "up"}, {"pageSize": "0"}, {"pageSize": "201"},
                       {"page": "x"}, {"customer": "nope"}, {"device": "x"}):
            with self.subTest(params):
                self.assertEqual(self.get(self.admin, "devices/", **params).status_code, 400)
        device = Device.objects.get(name="Alpha")
        self.assertEqual(self.get(self.admin, f"devices/{device.pk}/", page="1").status_code, 400)
        self.assertEqual(signed_in_client(self.admin).post(API + "devices/").status_code, 405)


class ContractTests(DeviceTestCase):
    def test_the_shape_of_every_response(self):
        device = self.device()
        iface = self.interface(device, 1)
        self.sample(iface, 30)
        for i in range(25):
            self.poll(device, 30 + 300 * i, reachable=i % 4 != 0)
        listed = self.listed()["items"][0]
        body = self.detail(device)
        self.assertEqual(listed, body["item"])
        self.assertEqual(set(body), {"generatedAt", "item", "polls", "interfaces"})
        self.assertEqual(set(listed), {"device", "state", "stale", "health", "reason", "interfaces", "customerName", "siteName"})
        self.assertEqual(
            set(listed["device"]),
            {"id", "name", "type", "address", "enabled", "siteId", "snmpVersion", "port", "pollIntervalSeconds",
             "timeoutSeconds", "retries", "agentAssigned", "agent"},
        )
        self.assertEqual(set(listed["device"]["agent"]), {"id", "name", "status", "lastSeenAt", "serverId", "serverName"})
        self.assertEqual(
            listed["state"],
            {"reachable": True, "error": None, "responseMs": 12.5, "uptimeSeconds": 123_456, "sysName": "core-sw.example",
             "sysDescr": "Switch OS 1.0", "sysObjectId": "1.3.6.1.4.1.9", "lastPollAt": iso(self.now - timedelta(seconds=10)),
             "lastSuccessAt": iso(self.now - timedelta(seconds=10)), "lastDiscoveryAt": None,
             "receivedAt": iso(self.now - timedelta(seconds=9))},
        )
        self.assertEqual(len(body["polls"]), 20)
        self.assertEqual(set(body["polls"][0]), {"measuredAt", "receivedAt", "reachable", "responseMs", "error"})
        self.assertEqual(body["polls"][0]["error"], "timeout")
        times = [p["measuredAt"] for p in body["polls"]]
        self.assertEqual(times, sorted(times, reverse=True))
        (interface,) = body["interfaces"]
        self.assertEqual(
            {k: interface[k] for k in interface if k != "rates"},
            {"ifIndex": 1, "name": "Gi0/1", "descr": "GigabitEthernet", "alias": "uplink", "type": 6, "speedBps": GBIT,
             "adminStatus": "up", "operStatus": "up", "operStatusChangedAt": None, "health": "healthy", "reason": "up"},
        )
        series = self.get(self.admin, f"devices/{device.pk}/series/").json()
        self.assertEqual(set(series), {"generatedAt", "bucketMs", "t", "responseMs", "reachablePolls", "failedPolls"})
        series = self.get(self.admin, f"devices/{device.pk}/interfaces/1/series/").json()
        self.assertEqual(
            set(series),
            {"generatedAt", "bucketMs", "t", "inBps", "outBps", "inBpsMax", "outBpsMax", "inErrorsPerSec", "outErrorsPerSec",
             "inDiscardsPerSec", "outDiscardsPerSec", "validSamples", "invalidSamples"},
        )


class QueryBoundTests(DeviceTestCase):
    def count(self, client, path):
        client.get(API + path)
        with CaptureQueriesContext(connection) as queries:
            self.assertEqual(client.get(API + path).status_code, 200)
        return len(queries)

    def grow(self, devices, interfaces, *, start):
        made = []
        for d in range(start, start + devices):
            device = self.device(f"dev-{d:03d}")
            for i in range(1, interfaces + 1):
                iface = self.interface(device, i)
                self.sample(iface, 330)
                self.sample(iface, 30)
            self.poll(device, 30)
            made.append(device)
        return made

    def test_the_number_of_queries_does_not_grow_with_devices_or_interfaces(self):
        client = signed_in_client(make_user("acme", customers=[self.acme]))
        first = self.grow(2, 2, start=0)[0]
        paths = ["devices/", "devices/?sort=response", "devices/?q=dev&status=healthy", f"devices/{first.pk}/",
                 f"devices/{first.pk}/series/?range=24h", f"devices/{first.pk}/interfaces/1/series/?range=24h"]
        small = {path: self.count(client, path) for path in paths}
        self.grow(30, 2, start=2)
        for i in range(3, 40):
            self.sample(self.interface(first, i), 30)
        large = {path: self.count(client, path) for path in paths}
        self.assertEqual(small, large)

    def test_the_interface_series_reads_only_its_window(self):
        device = self.device(interval=60)
        iface = self.interface(device, 1)
        InterfaceSample.objects.bulk_create(
            InterfaceSample(
                interface=iface, measured_at=self.now - timedelta(seconds=60 * j + 30), interval_seconds=60.0, admin_status=1,
                oper_status=1, speed_bps=GBIT, octets_bits=64, delta_state="ok", in_octets_delta=1, out_octets_delta=1,
                in_errors_delta=0, out_errors_delta=0, in_discards_delta=0, out_discards_delta=0,
            )
            for j in range(3000)
        )
        client = signed_in_client(self.admin)
        client.get(API + f"devices/{device.pk}/interfaces/1/series/?range=15m")
        with CaptureQueriesContext(connection) as queries:
            body = client.get(API + f"devices/{device.pk}/interfaces/1/series/?range=15m").json()
        self.assertEqual(sum(body["validSamples"]), 15)
        windowed = [q["sql"] for q in queries if "snmp_interfacesample" in q["sql"] and "measured_at" in q["sql"]]
        self.assertTrue(windowed)
        for sql in windowed:
            self.assertRegex(sql, r'"measured_at" >= .* AND .*"measured_at" < |LIMIT 1')
