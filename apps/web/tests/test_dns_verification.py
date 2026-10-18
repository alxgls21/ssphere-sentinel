"""The DNS verification against a domain's own name servers: a scripted DNS, and real sockets."""

import socket
import socketserver
import struct
import threading

import dns.exception
import dns.flags
import dns.message
import dns.name
import dns.rcode
import dns.rdatatype
import dns.resolver
import dns.rrset
from django.test import SimpleTestCase

from apps.web import dns_verification as dv
from apps.web.domains import new_token, record_value

TOKEN = new_token()
VALUE = record_value(TOKEN)
OTHER = record_value(new_token())
RECORD = "_ssphere-sentinel.example.com."
TLDS = {"com.": 1, "net.": 11, "org.": 21}  # each with three servers, a.<tld>servers.net and so on


def name(text: str) -> dns.name.Name:
    return dns.name.from_text(text)


def respond(question, *, aa=True, rcode=dns.rcode.NOERROR, txt=(), cname=None, dname=None):
    """An answer to ``question``: TXT records (each a list of strings), or a CNAME, or a DNAME."""
    response = dns.message.make_response(question)
    response.flags &= ~dns.flags.AA
    if aa:
        response.flags |= dns.flags.AA
    response.set_rcode(rcode)
    owner = question.question[0].name
    if txt:
        texts = [" ".join(f'"{part}"' for part in record) for record in txt]
        response.answer.append(dns.rrset.from_text_list(owner, 300, "IN", "TXT", texts))
    if cname:
        response.answer.append(dns.rrset.from_text(owner, 300, "IN", "CNAME", cname))
    if dname:
        dname_owner, target = dname
        response.answer.append(dns.rrset.from_text(dname_owner, 300, "IN", "DNAME", target))
    return response


def refer(question, zone, hosts, glue=()):
    response = respond(question, aa=False)
    response.authority.append(dns.rrset.from_text_list(zone, 300, "IN", "NS", list(hosts)))
    for host, address in glue:
        response.additional.append(dns.rrset.from_text(host, 300, "IN", "AAAA" if ":" in address else "A", address))
    return response


def has(*values, split=False):
    def answer(question):
        records = [[value[:21], value[21:]] if split else [value] for value in values]
        return respond(question, txt=records)

    return answer


def absent(question):
    return respond(question)


def nxdomain(question):
    return respond(question, rcode=dns.rcode.NXDOMAIN)


def alias(target):
    return lambda question: respond(question, cname=target)


def fails(error):
    def answer(question):
        raise error

    answer.fails = True  # whatever it is asked
    return answer


def answers(**kwargs):
    return lambda question: respond(question, **kwargs)


def by_name(table):
    return lambda question: table[question.question[0].name.to_text()](question)


class FakeNetwork(dv.Network):
    """A small DNS: zones, their servers' addresses and what each answers. A server of a zone
    delegates a name under a zone registered below it (with glue for names inside it);
    otherwise it answers as its behaviour says. com, net and org are there, answering
    NXDOMAIN for anything not delegated."""

    def __init__(self, *, glue=True):
        self.glue = glue
        self.zones: dict[str, list[str]] = {}
        self.hosts: dict[str, dict[str, list[str]]] = {}
        self.server_zone: dict[str, str] = {}
        self.servers = {}
        self.asked: list[str] = []
        self.questions: list[dns.message.Message] = []
        self.looked_up: list[str] = []
        self.zones_asked: list[str] = []
        # What the resolver says of a name, when it is not what its delegation's glue says.
        self.resolved: dict[str, list[str]] = {}
        # A server's own answers to address questions, when it is not its zone's data.
        self.address_answers = {}
        for tld, first in TLDS.items():
            servers = {f"{letter}.{tld}servers.net.": (f"203.0.113.{first + n}", nxdomain) for n, letter in enumerate("abc")}
            self.zone(tld, servers)

    def zone(self, zone: str, servers: dict):
        """``servers``: name server -> (address, behaviour), or a list of them."""
        self.zones[zone] = list(servers)
        for host, entries in servers.items():
            entries = entries if isinstance(entries, list) else [entries]
            family = self.hosts.setdefault(host, {"A": [], "AAAA": []})
            for address, behaviour in entries:
                family["AAAA" if ":" in address else "A"].append(address)
                self.servers[address] = behaviour
                self.server_zone[address] = zone
        return self

    def asked_in(self, zone: str) -> list[str]:
        return [address for address in self.asked if self.server_zone[address] == zone]

    def zone_of(self, query_name, timeout):
        self.zones_asked.append(query_name.to_text())
        zones = [zone for zone in self.zones if query_name.is_subdomain(name(zone))]
        if not zones:
            raise dns.resolver.NoNameservers
        return name(max(zones, key=len))

    def nameservers(self, zone, timeout):
        return [name(host) for host in self.zones[zone.to_text()]]

    def addresses(self, host, rdtype, timeout):
        self.looked_up.append(host.to_text())
        if host.to_text() in self.resolved:
            return [address for address in self.resolved[host.to_text()] if (":" in address) == (rdtype == "AAAA")]
        return self.hosts.get(host.to_text(), {}).get(rdtype, [])

    def ask(self, address, question, timeout, left):
        self.asked.append(address)
        self.questions.append(question)
        if getattr(self.servers[address], "fails", False):
            return self.servers[address](question)  # a server that fails, fails whatever it is asked
        own = name(self.server_zone[address])
        qname = question.question[0].name
        if question.question[0].rdtype == dns.rdatatype.NS and qname == own:
            response = respond(question)
            response.answer.append(dns.rrset.from_text_list(own, 300, "IN", "NS", self.zones[own.to_text()]))
            return response
        below = [
            zone for zone in self.zones
            if name(zone) != own and name(zone).is_subdomain(own) and qname.is_subdomain(name(zone))
        ]
        if below:
            child = min(below, key=len)
            glue = [
                (host, address)
                for host in self.zones[child]
                if self.glue and name(host).is_subdomain(name(child))
                for address in self.hosts[host]["A"] + self.hosts[host]["AAAA"]
            ]
            return refer(question, child, self.zones[child], glue)
        behaviour = self.servers[address]
        rdtype = question.question[0].rdtype
        if rdtype in (dns.rdatatype.A, dns.rdatatype.AAAA):
            if address in self.address_answers:
                return self.address_answers[address](question)
            # The zone's own data: the addresses of the names in it (the name servers').
            table = self.hosts.get(qname.to_text())
            if table is None:
                return respond(question, rcode=dns.rcode.NXDOMAIN)
            response = respond(question)
            family = "A" if rdtype == dns.rdatatype.A else "AAAA"
            if table[family]:
                response.answer.append(dns.rrset.from_text_list(qname, 300, "IN", family, table[family]))
            return response
        return behaviour(question)


def three(first, second=None, third=None, provider="dns-host.net"):
    second = second or first
    third = third or second
    return {
        f"ns1.{provider}.": ("192.0.2.1", first),
        f"ns2.{provider}.": ("198.51.100.2", second),
        f"ns3.{provider}.": ("203.0.113.103", third),
    }


def allow_documentation(address):
    """The scripted servers use documentation addresses, which are not public: allowed here only."""
    return address.startswith(("192.0.2.", "198.51.100.", "203.0.113.", "2001:db8:"))


def verify(network, *, values=(VALUE,), **kwargs):
    kwargs.setdefault("allowed", allow_documentation)
    return dv.verify("example.com", list(values), network=network, **kwargs)


def results(result):
    return [server["result"] for server in result.evidence["nameservers"]]


class OutcomeTests(SimpleTestCase):
    def test_every_server_has_the_record(self):
        network = FakeNetwork().zone("example.com.", three(has(VALUE)))
        result = verify(network)
        self.assertEqual((result.outcome, result.detail), (dv.VERIFIED, dv.FOUND))
        self.assertEqual(result.evidence["zone"], "example.com")
        self.assertEqual(result.evidence["nameserverCount"], 3)
        self.assertEqual(results(result), ["match"] * 3)
        self.assertEqual(sorted(network.asked_in("example.com.")), ["192.0.2.1", "198.51.100.2", "203.0.113.103"])

    def test_the_delegation_is_followed_from_the_public_suffix_not_taken_from_a_resolver(self):
        network = FakeNetwork().zone("example.com.", three(has(VALUE)))
        verify(network)
        # The resolver is asked where suffixes are served (the domain's, its name servers'), once each,
        # never about the domain, the record or the name servers.
        self.assertEqual(network.zones_asked, ["com.", "net."])
        self.assertEqual([host for host in network.looked_up if "dns-host" in host], [])
        self.assertEqual(len(network.asked_in("com.")), 3)  # the referral servers of com
        self.assertNotIn("example.com.", network.zones_asked)

    def test_each_question_is_txt_of_the_record_name_without_recursion_with_its_own_id(self):
        network = FakeNetwork().zone("example.com.", three(has(VALUE)))
        verify(network)
        txt = [question for question in network.questions if question.question[0].rdtype == dns.rdatatype.TXT]
        self.assertGreater(len(txt), 3)
        for question in txt:
            self.assertEqual(question.question[0].name, name(RECORD))
        # The others are the name servers' addresses, asked of their own zone's servers.
        for question in network.questions:
            self.assertIn(question.question[0].rdtype, (dns.rdatatype.TXT, dns.rdatatype.A, dns.rdatatype.AAAA))
            self.assertFalse(question.flags & dns.flags.RD)
            self.assertEqual((question.edns, question.payload), (0, 1232))
        # A new message for every question sent (dnspython gives each a random ID).
        self.assertEqual(len({id(question) for question in network.questions}), len(network.questions))
        self.assertGreater(len({question.id for question in network.questions}), 1)

    def test_the_value_among_other_records_and_split_across_strings(self):
        network = FakeNetwork().zone(
            "example.com.", three(has("v=spf1 -all", OTHER, VALUE), has(VALUE, split=True), has(OTHER, VALUE))
        )
        self.assertEqual(verify(network).outcome, dv.VERIFIED)

    def test_every_record_is_read(self):
        many = [f"filler-{n}" for n in range(150)] + [VALUE]
        network = FakeNetwork().zone("example.com.", three(has(*many)))
        self.assertEqual(verify(network).outcome, dv.VERIFIED)

    def test_only_the_exact_value_matches(self):
        for near in (VALUE.upper(), VALUE + " ", " " + VALUE, VALUE[:-1], f"ssphere-verification = {TOKEN}", TOKEN):
            with self.subTest(near=near):
                network = FakeNetwork().zone("example.com.", three(has(near)))
                self.assertEqual(verify(network).outcome, dv.ABSENT)

    def test_another_customers_value_is_not_this_ones(self):
        result = verify(FakeNetwork().zone("example.com.", three(has(OTHER))))
        self.assertEqual((result.outcome, result.detail), (dv.ABSENT, dv.NOT_FOUND))

    def test_absent_no_such_name_and_no_txt_are_all_absent(self):
        network = FakeNetwork().zone("example.com.", three(absent, nxdomain, has("unrelated")))
        result = verify(network)
        self.assertEqual((result.outcome, result.detail), (dv.ABSENT, dv.NOT_FOUND))
        self.assertEqual(results(result), ["no_match"] * 3)

    def test_a_domain_that_does_not_exist_is_absent(self):
        # Not delegated: the suffix's servers say so with authority, all of them asked.
        result = verify(FakeNetwork())
        self.assertEqual((result.outcome, result.evidence["zone"]), (dv.ABSENT, "com"))
        self.assertEqual(results(result), ["no_match"] * 3)

    def test_servers_that_disagree_mean_the_change_is_still_spreading(self):
        network = FakeNetwork().zone("example.com.", three(has(VALUE), has(VALUE), absent))
        result = verify(network)
        self.assertEqual((result.outcome, result.detail), (dv.PROPAGATION_PENDING, dv.SERVERS_DISAGREE))
        self.assertEqual(results(result), ["match", "match", "no_match"])

    def test_one_server_with_the_record_is_not_enough(self):
        timeout = fails(dns.exception.Timeout())
        network = FakeNetwork().zone("example.com.", three(has(VALUE), timeout, timeout))
        result = verify(network)
        self.assertEqual((result.outcome, result.detail), (dv.INDETERMINATE, dv.INSUFFICIENT_COVERAGE))

    def test_a_majority_that_agrees_is_enough(self):
        network = FakeNetwork().zone("example.com.", three(has(VALUE), has(VALUE), fails(dns.exception.Timeout())))
        self.assertEqual(verify(network).outcome, dv.VERIFIED)
        network = FakeNetwork().zone("example.com.", three(absent, nxdomain, answers(rcode=dns.rcode.SERVFAIL)))
        self.assertEqual(verify(network).outcome, dv.ABSENT)

    def test_two_servers_need_both(self):
        servers = {"ns1.dns-host.net.": ("192.0.2.1", has(VALUE)), "ns2.dns-host.net.": ("192.0.2.2", fails(OSError()))}
        self.assertEqual(verify(FakeNetwork().zone("example.com.", servers)).detail, dv.INSUFFICIENT_COVERAGE)

    def test_a_zone_with_one_server(self):
        network = FakeNetwork().zone("example.com.", {"ns.dns-host.net.": ("192.0.2.1", has(VALUE))})
        self.assertEqual(verify(network).outcome, dv.VERIFIED)

    def test_the_majority_is_of_every_name_server_of_the_zone(self):
        servers = {f"ns{n:02}.dns-host.net.": (f"192.0.2.{n}", has(VALUE)) for n in range(1, 13)}
        network = FakeNetwork().zone("example.com.", servers)
        # More than can all be asked: nothing is concluded, and none of them is asked.
        result = verify(network, limits=dv.Limits(max_nameservers=4))
        self.assertEqual((result.outcome, result.detail), (dv.INDETERMINATE, dv.INSUFFICIENT_COVERAGE))
        self.assertEqual(network.asked_in("example.com."), [])
        network = FakeNetwork().zone("example.com.", servers)
        result = verify(network)
        self.assertEqual((result.outcome, result.evidence["nameserverCount"]), (dv.VERIFIED, 12))
        self.assertEqual(len(network.asked_in("example.com.")), 12)

    def test_the_delegations_names_are_counted_not_their_addresses(self):
        # ns2 and ns3 share an address: the parent delegates to both names, so both count.
        network = FakeNetwork().zone("example.com.", {
            "ns1.dns-host.net.": ("192.0.2.1", fails(dns.exception.Timeout())),
            "ns2.dns-host.net.": ("192.0.2.9", has(VALUE)),
            "ns3.dns-host.net.": ("192.0.2.9", has(VALUE)),
        })
        network.hosts["ns3.dns-host.net."]["A"] = ["192.0.2.9"]
        result = verify(network)
        self.assertEqual((result.outcome, result.evidence["nameserverCount"]), (dv.VERIFIED, 3))
        # One of three names answering is not enough, whatever addresses they have.
        network = FakeNetwork().zone("example.com.", three(fails(dns.exception.Timeout()), fails(OSError()), has(VALUE)))
        self.assertEqual(verify(network).detail, dv.INSUFFICIENT_COVERAGE)

    def test_a_name_that_claims_the_other_servers_addresses_still_counts_once(self):
        # ns3 has been taken over: its name now resolves to its own address first, then to the
        # legitimate servers' (which do not answer Sentinel just now). It is one name of three.
        down = fails(dns.exception.Timeout())
        network = FakeNetwork().zone("example.com.", three(down, down, has(VALUE)))
        network.servers["192.0.2.0"] = has(VALUE)
        network.server_zone["192.0.2.0"] = "example.com."
        network.hosts["ns3.dns-host.net."]["A"] = ["192.0.2.0", "192.0.2.1", "198.51.100.2"]
        result = verify(network)
        self.assertEqual((result.outcome, result.detail), (dv.INDETERMINATE, dv.INSUFFICIENT_COVERAGE))

    def test_a_name_that_claims_a_silent_servers_address_still_counts_once(self):
        # Two name servers; the honest one does not answer Sentinel. The rogue's name resolves to
        # the honest server's address first (which times out), then to its own: one name of two.
        network = FakeNetwork().zone("example.com.", {
            "ns1.dns-host.net.": ("192.0.2.1", fails(dns.exception.Timeout())),
            "ns.attacker-dns.org.": ("198.51.100.9", has(VALUE)),
        })
        network.hosts["ns.attacker-dns.org."]["A"] = ["192.0.2.1", "198.51.100.9"]
        result = verify(network)
        self.assertEqual((result.outcome, result.detail), (dv.INDETERMINATE, dv.INSUFFICIENT_COVERAGE))

    def test_a_delegation_from_a_name_that_claims_the_others_addresses_is_one_of_three(self):
        down = fails(dns.exception.Timeout())
        network = FakeNetwork().zone("example.com.", three(down, down, absent))
        network.servers["192.0.2.0"] = lambda question: refer(question, RECORD, ["ns.attack-dns.org."])
        network.server_zone["192.0.2.0"] = "elsewhere."
        network.hosts["ns3.dns-host.net."]["A"] = ["192.0.2.0", "192.0.2.1", "198.51.100.2"]
        network.zone("attack-dns.org.", {"ns.attack-dns.org.": ("192.0.2.66", has(VALUE))})
        result = verify(network)
        self.assertEqual((result.outcome, result.detail), (dv.INDETERMINATE, dv.INSUFFICIENT_COVERAGE))
        self.assertNotIn("192.0.2.66", network.asked)

    def test_a_server_with_several_addresses_counts_once(self):
        network = FakeNetwork().zone("example.com.", {
            "ns1.dns-host.net.": [("192.0.2.1", has(VALUE)), ("2001:db8::1", has(VALUE))],
            "ns2.dns-host.net.": ("192.0.2.2", fails(dns.exception.Timeout())),
        })
        result = verify(network)
        self.assertEqual((result.outcome, result.detail), (dv.INDETERMINATE, dv.INSUFFICIENT_COVERAGE))
        self.assertEqual(network.asked_in("example.com."), ["192.0.2.1", "192.0.2.2"])

    def test_one_name_in_two_spellings_is_one_server(self):
        network = FakeNetwork().zone("example.com.", {
            "ns1.dns-host.net.": ("192.0.2.1", has(VALUE)),
            "NS1.Dns-Host.NET.": ("192.0.2.1", has(VALUE)),
            "ns2.dns-host.net.": ("192.0.2.2", fails(dns.exception.Timeout())),
        })
        result = verify(network)
        self.assertEqual(result.evidence["nameserverCount"], 2)
        self.assertEqual(result.detail, dv.INSUFFICIENT_COVERAGE)

    def test_failures_are_never_absence(self):
        cases = {
            dv.TIMEOUT: fails(dns.exception.Timeout()),
            dv.NETWORK_ERROR: fails(ConnectionRefusedError()),
            dv.SERVER_FAILURE: answers(rcode=dns.rcode.SERVFAIL),
            dv.REFUSED: answers(rcode=dns.rcode.REFUSED),
            dv.NOT_AUTHORITATIVE: answers(aa=False, txt=[[VALUE]]),
            dv.MALFORMED_RESPONSE: fails(dns.exception.FormError()),
        }
        for detail, behaviour in cases.items():
            with self.subTest(detail=detail):
                result = verify(FakeNetwork().zone("example.com.", three(behaviour)))
                self.assertEqual((result.outcome, result.detail), (dv.INDETERMINATE, detail))

    def test_an_answer_that_is_not_authoritative_never_counts(self):
        lame = answers(aa=False, txt=[[VALUE]])
        network = FakeNetwork().zone("example.com.", three(has(VALUE), lame, lame))
        self.assertEqual(verify(network).detail, dv.INSUFFICIENT_COVERAGE)

    def test_an_answer_to_another_question_is_malformed(self):
        def elsewhere(question):
            return respond(dns.message.make_query("_ssphere-sentinel.attacker.example.", "TXT"), txt=[[VALUE]])

        result = verify(FakeNetwork().zone("example.com.", three(elsewhere)))
        self.assertEqual((result.outcome, result.detail), (dv.INDETERMINATE, dv.MALFORMED_RESPONSE))

    def test_a_server_is_asked_at_its_next_address_when_the_first_fails(self):
        network = FakeNetwork().zone(
            "example.com.",
            {
                "ns1.dns-host.net.": [("192.0.2.1", fails(dns.exception.Timeout())), ("2001:db8::1", has(VALUE))],
                "ns2.dns-host.net.": ("198.51.100.2", has(VALUE)),
            },
        )
        result = verify(network)
        self.assertEqual(result.outcome, dv.VERIFIED)
        self.assertEqual(network.asked_in("example.com."), ["192.0.2.1", "2001:db8::1", "198.51.100.2"])
        self.assertEqual(result.evidence["nameservers"][0]["address"], "2001:db8::1")


class DelegationTests(SimpleTestCase):
    def test_a_rogue_server_of_the_domain_cannot_verify_it_alone(self):
        # ns3 has been taken over (a lame delegation claimed by someone else): it has the value.
        network = FakeNetwork().zone("example.com.", three(absent, absent, has(VALUE)))
        self.assertEqual(verify(network).outcome, dv.PROPAGATION_PENDING)
        network = FakeNetwork().zone("example.com.", three(fails(dns.exception.Timeout()), absent, has(VALUE)))
        self.assertEqual(verify(network).outcome, dv.PROPAGATION_PENDING)

    def test_a_rogue_server_cannot_move_the_zone_below_the_domain(self):
        def claims_a_zone(question):
            return refer(question, RECORD, ["ns.attacker-dns.net."])

        network = FakeNetwork().zone("example.com.", three(absent, absent, claims_a_zone))
        network.zone("attacker-dns.net.", {"ns.attacker-dns.net.": ("192.0.2.66", has(VALUE))})
        result = verify(network)
        self.assertEqual((result.outcome, result.detail), (dv.PROPAGATION_PENDING, dv.SERVERS_DISAGREE))
        self.assertNotIn("192.0.2.66", network.asked)

    def test_a_delegated_subzone_is_followed(self):
        network = FakeNetwork().zone("example.com.", three(absent))
        network.zone("shop.example.com.", {
            "ns1.shop.example.com.": ("192.0.2.31", has(VALUE)),
            "ns2.shop.example.com.": ("192.0.2.32", has(VALUE)),
        })
        result = dv.verify("shop.example.com", [VALUE], network=network, allowed=allow_documentation)
        self.assertEqual((result.outcome, result.evidence["zone"]), (dv.VERIFIED, "shop.example.com"))
        # Their addresses came with the delegation (glue): the resolver was not asked for them.
        self.assertNotIn("ns1.shop.example.com.", network.looked_up)

    def test_a_server_of_both_zones_answering_from_the_closer_one_agrees(self):
        # ns1 serves example.com and its subzone shop.example.com: asked as a server of
        # example.com, it answers from shop.example.com; ns2 delegates it.
        network = FakeNetwork().zone("example.com.", {
            "ns1.dns-host.net.": ("192.0.2.1", has(VALUE)), "ns2.dns-host.net.": ("192.0.2.2", absent),
        })
        network.zone("shop.example.com.", {
            "ns1.dns-host.net.": ("192.0.2.1", has(VALUE)), "ns3.dns-host.net.": ("192.0.2.3", has(VALUE)),
        })
        network.server_zone["192.0.2.1"] = "shop.example.com."  # it answers for the closer zone
        result = dv.verify("shop.example.com", [VALUE], network=network, allowed=allow_documentation)
        self.assertEqual((result.outcome, result.evidence["zone"]), (dv.VERIFIED, "shop.example.com"))

    def test_a_delegation_from_two_delegated_names_on_one_address_is_two_of_three(self):
        # Both names are example.com's, given by its parent: they count as two.
        network = FakeNetwork().zone("example.com.", {
            "ns1.dns-host.net.": ("192.0.2.9", absent),
            "ns2.dns-host.net.": ("192.0.2.9", absent),
            "ns3.dns-host.net.": ("192.0.2.3", fails(dns.exception.Timeout())),
        })
        network.hosts["ns2.dns-host.net."]["A"] = ["192.0.2.9"]
        network.server_zone["192.0.2.3"] = "elsewhere."  # its timeout, not a scripted delegation
        network.zone("shop.example.com.", {"ns.shop-dns.net.": ("192.0.2.80", has(VALUE))})
        result = dv.verify("shop.example.com", [VALUE], network=network, allowed=allow_documentation)
        self.assertEqual((result.outcome, result.evidence["zone"]), (dv.VERIFIED, "shop.example.com"))

    def test_one_rogue_server_cannot_choose_the_next_servers_by_naming_the_others_too(self):
        # ns3 has been taken over; it delegates the record's name to its own servers, listing the
        # legitimate ones as well (and enough of its own to push them out of who is asked).
        attackers = [(f"a{n:02d}.{RECORD}", f"2001:db8::{n + 100:x}") for n in range(13)]
        for listed in (attackers, attackers[:3]):
            with self.subTest(attackers=len(listed)):
                def rogue(question, listed=listed):
                    hosts = ["ns1.dns-host.net.", "ns2.dns-host.net."] + [host for host, _ in listed]
                    return refer(question, RECORD, hosts, listed)

                network = FakeNetwork().zone("example.com.", three(absent, absent, rogue))
                network.zone("attacker.invalid.", {host: (address, has(VALUE)) for host, address in listed})
                result = verify(network)
                self.assertNotEqual(result.outcome, dv.VERIFIED)
                self.assertFalse(set(network.asked) & {address for _, address in listed})

    def test_one_rogue_server_cannot_delegate_a_subzone_alone(self):
        attackers = [(f"a{n:02d}.shop.example.com.", f"2001:db8::{n + 100:x}") for n in range(3)]

        def rogue(question):
            return refer(question, "shop.example.com.", [host for host, _ in attackers], attackers)

        network = FakeNetwork().zone("example.com.", three(absent, absent, rogue))
        network.zone("shop.example.com.", {
            "ns1.shop.example.com.": ("192.0.2.31", absent), "ns2.shop.example.com.": ("192.0.2.32", absent),
        })
        network.zone("attacker.invalid.", {host: (address, has(VALUE)) for host, address in attackers})
        network.server_zone["203.0.113.103"] = "elsewhere."  # only its scripted delegation
        result = dv.verify("shop.example.com", [VALUE], network=network, allowed=allow_documentation)
        self.assertEqual((result.outcome, result.detail), (dv.PROPAGATION_PENDING, dv.SERVERS_DISAGREE))
        self.assertFalse(set(network.asked) & {address for _, address in attackers})

    def test_a_rogue_server_with_a_flaky_legitimate_one_still_cannot_verify(self):
        attackers = [(f"a{n:02d}.{RECORD}", f"2001:db8::{n + 100:x}") for n in range(3)]
        asked = []

        def flaky(question):
            asked.append(question)
            if len(asked) > 1:
                raise dns.exception.Timeout
            return absent(question)

        def rogue(question):
            return refer(question, RECORD, ["ns1.dns-host.net."] + [host for host, _ in attackers], attackers)

        network = FakeNetwork().zone("example.com.", {
            "ns1.dns-host.net.": ("192.0.2.1", flaky), "ns3.dns-host.net.": ("203.0.113.103", rogue),
        })
        network.zone("attacker.invalid.", {host: (address, has(VALUE)) for host, address in attackers})
        self.assertNotEqual(verify(network).outcome, dv.VERIFIED)

    def test_delegations_that_differ_in_their_servers_disagree(self):
        def to(hosts, glue=()):
            return lambda question: refer(question, "shop.example.com.", hosts, glue)

        same = ["ns1.shop.example.com.", "ns2.shop.example.com."]
        cases = {
            "servers": (to(same), to(same), to(same[:1])),
        }
        for case, behaviours in cases.items():
            with self.subTest(case=case):
                network = FakeNetwork().zone("example.com.", three(*behaviours))
                for address in ("192.0.2.1", "198.51.100.2", "203.0.113.103"):
                    network.server_zone[address] = "elsewhere."  # only their scripted delegations
                result = dv.verify("shop.example.com", [VALUE], network=network, allowed=allow_documentation)
                self.assertEqual((result.outcome, result.detail), (dv.PROPAGATION_PENDING, dv.SERVERS_DISAGREE))

    def test_only_the_addresses_most_servers_give_are_used(self):
        def to(glue):
            hosts = ["ns1.shop.example.com.", "ns2.shop.example.com."]
            return lambda question: refer(question, "shop.example.com.", hosts, glue)

        network = FakeNetwork(glue=False).zone("example.com.", three(
            # The first gives another address for ns1 (one that would be asked first), none for ns2.
            to([("ns1.shop.example.com.", "192.0.2.10")]),
            to([("ns1.shop.example.com.", "192.0.2.31"), ("ns2.shop.example.com.", "192.0.2.32")]),
            to([("ns1.shop.example.com.", "192.0.2.31"), ("ns2.shop.example.com.", "192.0.2.32")]),
        ))
        for address in ("192.0.2.1", "198.51.100.2", "203.0.113.103"):
            network.server_zone[address] = "elsewhere."
        network.zone("shop.example.com.", {
            "ns1.shop.example.com.": ("192.0.2.31", has(VALUE)), "ns2.shop.example.com.": ("192.0.2.32", has(VALUE)),
        })
        for address in ("192.0.2.31", "192.0.2.32"):
            network.server_zone[address] = "shop.example.com."
        result = dv.verify("shop.example.com", [VALUE], network=network, allowed=allow_documentation)
        self.assertEqual(result.outcome, dv.VERIFIED)
        # Two of three gave the right addresses: those are used; the first's never, nor the resolver.
        self.assertNotIn("192.0.2.10", network.asked)
        self.assertNotIn("ns1.shop.example.com.", network.looked_up)

    def glue_attack(self, servers, rogue_address, glue):
        """shop.example.com is delegated by example.com's ``servers``; the one at ``rogue_address``
        is taken over: it gives the right names with ``glue`` (none, or its own address for them),
        and the resolver would send those names to it too. Its address sorts first."""
        hosts = ["ns1.shop.example.com.", "ns2.shop.example.com."]
        network = FakeNetwork().zone("example.com.", servers)
        network.zone("shop.example.com.", {
            "ns1.shop.example.com.": ("192.0.2.31", absent), "ns2.shop.example.com.": ("192.0.2.32", absent),
        })
        network.servers[rogue_address] = lambda question: refer(
            question, "shop.example.com.", hosts, [(host, "192.0.2.10") for host in hosts] if glue else []
        )
        network.server_zone[rogue_address] = "elsewhere."
        network.servers["192.0.2.10"] = has(VALUE)
        network.server_zone["192.0.2.10"] = "shop.example.com."
        for host in hosts:
            network.resolved[host] = ["192.0.2.10"]
        result = dv.verify("shop.example.com", [VALUE], network=network, allowed=allow_documentation)
        self.assertNotEqual(result.outcome, dv.VERIFIED)
        self.assertNotIn("192.0.2.10", network.asked)
        self.assertEqual([host for host in network.looked_up if "shop" in host], [])
        return result

    def test_a_server_that_strips_or_forges_the_glue_cannot_choose_the_childs_addresses(self):
        two = {"ns1.dns-host.net.": ("192.0.2.1", absent), "ns2.dns-host.net.": ("198.51.100.2", absent)}
        for glue in (False, True):
            for servers in (three(absent), two):
                for rogue in ("192.0.2.1", "198.51.100.2"):  # first and second in the order asked
                    with self.subTest(glue=glue, servers=len(servers), rogue=rogue):
                        result = self.glue_attack(dict(servers), rogue, glue)
                        if len(servers) == 3:
                            # Outvoted: the two others agree on the delegation and its glue.
                            self.assertEqual((result.outcome, result.detail), (dv.ABSENT, dv.NOT_FOUND))

    def test_a_server_that_strips_or_forges_glue_deeper_down_is_outvoted_too(self):
        hosts = ["ns1.eu.shop.example.com.", "ns2.eu.shop.example.com."]
        for glue in ([], [(host, "192.0.2.10") for host in hosts]):
            with self.subTest(glue=bool(glue)):
                network = FakeNetwork().zone("example.com.", three(absent))
                network.zone("shop.example.com.", {
                    "ns1.shop.example.com.": ("192.0.2.31", absent), "ns2.shop.example.com.": ("192.0.2.32", absent),
                    "ns3.shop.example.com.": ("192.0.2.33", absent),
                })
                network.zone("eu.shop.example.com.", {
                    "ns1.eu.shop.example.com.": ("192.0.2.51", absent), "ns2.eu.shop.example.com.": ("192.0.2.52", absent),
                })
                network.servers["192.0.2.31"] = lambda question, glue=glue: refer(question, "eu.shop.example.com.", hosts, glue)
                network.server_zone["192.0.2.31"] = "elsewhere."
                network.servers["192.0.2.10"] = has(VALUE)
                network.server_zone["192.0.2.10"] = "eu.shop.example.com."
                for host in hosts:
                    network.resolved[host] = ["192.0.2.10"]
                result = dv.verify("eu.shop.example.com", [VALUE], network=network, allowed=allow_documentation)
                self.assertEqual((result.outcome, result.evidence["zone"]), (dv.ABSENT, "eu.shop.example.com"))
                self.assertNotIn("192.0.2.10", network.asked)

    def test_a_lone_referrers_glue_is_not_used_though_the_others_confirm(self):
        # ns1 and ns2 serve both zones and confirm; ns3, taken over, alone refers, with its own glue.
        hosts = ["ns1.dns-host.net.", "ns2.dns-host.net.", "ns1.shop.example.com.", "ns2.shop.example.com."]
        network = FakeNetwork().zone("example.com.", {
            "ns1.dns-host.net.": ("192.0.2.1", absent), "ns2.dns-host.net.": ("192.0.2.2", absent),
            "ns3.dns-host.net.": ("192.0.2.3", absent),
        })
        network.zone("shop.example.com.", {
            "ns1.dns-host.net.": ("192.0.2.1", absent), "ns2.dns-host.net.": ("192.0.2.2", absent),
            "ns1.shop.example.com.": ("192.0.2.31", absent), "ns2.shop.example.com.": ("192.0.2.32", absent),
        })
        network.server_zone["192.0.2.1"] = network.server_zone["192.0.2.2"] = "shop.example.com."
        network.servers["192.0.2.3"] = lambda question: refer(
            question, "shop.example.com.", hosts, [(host, "198.51.100.66") for host in hosts[2:]]
        )
        network.server_zone["192.0.2.3"] = "elsewhere."
        network.servers["198.51.100.66"] = has(VALUE)
        network.server_zone["198.51.100.66"] = "shop.example.com."
        result = dv.verify("shop.example.com", [VALUE], network=network, allowed=allow_documentation)
        self.assertNotEqual(result.outcome, dv.VERIFIED)
        self.assertNotIn("198.51.100.66", network.asked)

    def test_glue_one_server_alone_gives_is_not_enough(self):
        # Two servers delegate without glue, one with it: no address has a majority.
        def bare(question):
            return refer(question, "shop.example.com.", ["ns1.shop.example.com."])

        def glued(question):
            return refer(question, "shop.example.com.", ["ns1.shop.example.com."], [("ns1.shop.example.com.", "192.0.2.31")])

        network = FakeNetwork(glue=False).zone("example.com.", three(bare, bare, glued))
        for address in ("192.0.2.1", "198.51.100.2", "203.0.113.103"):
            network.server_zone[address] = "elsewhere."
        network.zone("shop.example.com.", {"ns1.shop.example.com.": ("192.0.2.31", has(VALUE))})
        result = dv.verify("shop.example.com", [VALUE], network=network, allowed=allow_documentation)
        self.assertEqual((result.outcome, result.detail), (dv.INDETERMINATE, dv.NO_PUBLIC_NAMESERVERS))
        self.assertNotIn("192.0.2.31", network.asked)

    def test_a_confirming_server_named_inside_the_child_zone_is_asked_where_it_answered(self):
        network = FakeNetwork().zone("example.com.", {
            "ns1.shop.example.com.": ("192.0.2.31", has(VALUE)),
            "ns2.dns-host.net.": ("198.51.100.2", absent), "ns3.dns-host.net.": ("203.0.113.103", absent),
        })
        network.zone("shop.example.com.", {
            "ns1.shop.example.com.": ("192.0.2.31", has(VALUE)), "ns2.shop.example.com.": ("192.0.2.32", has(VALUE)),
        })
        network.server_zone["192.0.2.31"] = "shop.example.com."  # it answers for the closer zone
        result = dv.verify("shop.example.com", [VALUE], network=network, allowed=allow_documentation)
        self.assertEqual((result.outcome, result.evidence["zone"]), (dv.VERIFIED, "shop.example.com"))
        self.assertEqual([server["address"] for server in result.evidence["nameservers"]], ["192.0.2.31", "192.0.2.32"])
        # The delegating servers give no address for it: where it answered is the one used.
        hosts = ["ns1.shop.example.com.", "ns2.shop.example.com."]
        for address in ("198.51.100.2", "203.0.113.103"):
            network.servers[address] = lambda question: refer(
                question, "shop.example.com.", hosts, [("ns2.shop.example.com.", "192.0.2.32")]
            )
            network.server_zone[address] = "elsewhere."
        network.resolved["ns1.shop.example.com."] = ["192.0.2.10"]  # never asked of the resolver
        result = dv.verify("shop.example.com", [VALUE], network=network, allowed=allow_documentation)
        self.assertEqual(result.outcome, dv.VERIFIED)
        self.assertNotIn("192.0.2.10", network.asked)

    def test_a_shared_server_whose_zone_lists_other_servers_than_its_parent_is_not_disagreement(self):
        network = FakeNetwork().zone("example.com.", {
            "ns1.dns-host.net.": ("192.0.2.1", has(VALUE)), "ns2.dns-host.net.": ("192.0.2.2", absent),
            "ns4.dns-host.net.": ("192.0.2.4", absent),
        })
        network.zone("shop.example.com.", {
            "ns1.dns-host.net.": ("192.0.2.1", has(VALUE)), "ns3.dns-host.net.": ("192.0.2.3", has(VALUE)),
        })
        network.server_zone["192.0.2.1"] = "shop.example.com."
        ask = network.ask

        def apex_lists_more(address, question, timeout, left):
            response = ask(address, question, timeout, left)
            if address == "192.0.2.1" and question.question[0].rdtype == dns.rdatatype.NS:
                hosts = ["ns1.dns-host.net.", "ns3.dns-host.net.", "ns5.dns-host.net."]
                response.answer[0] = dns.rrset.from_text_list(response.answer[0].name, 300, "IN", "NS", hosts)
            return response

        network.ask = apex_lists_more
        result = dv.verify("shop.example.com", [VALUE], network=network, allowed=allow_documentation)
        self.assertEqual((result.outcome, result.evidence["zone"]), (dv.VERIFIED, "shop.example.com"))

    def test_a_delegation_to_more_servers_than_can_be_asked_concludes_nothing(self):
        hosts = [f"ns{n:02}.shop-dns.net." for n in range(14)]
        network = FakeNetwork().zone("example.com.", three(lambda question: refer(question, "shop.example.com.", hosts)))
        for address in ("192.0.2.1", "198.51.100.2", "203.0.113.103"):
            network.server_zone[address] = "elsewhere."
        result = dv.verify("shop.example.com", [VALUE], network=network, allowed=allow_documentation)
        self.assertEqual((result.outcome, result.detail), (dv.INDETERMINATE, dv.INSUFFICIENT_COVERAGE))

    def test_an_answer_from_a_server_the_delegation_does_not_name_disagrees(self):
        network = FakeNetwork().zone("example.com.", three(has(VALUE)))
        network.zone("shop.example.com.", {"ns.shop-dns.net.": ("192.0.2.80", has(VALUE))})
        network.server_zone["192.0.2.1"] = "shop.example.com."  # ns1 answers, though not shop's
        result = dv.verify("shop.example.com", [VALUE], network=network, allowed=allow_documentation)
        self.assertEqual((result.outcome, result.detail), (dv.PROPAGATION_PENDING, dv.SERVERS_DISAGREE))

    def test_a_delegation_with_the_aa_flag_is_still_a_delegation(self):
        def flagged(question):
            response = refer(question, "example.com.", ["ns1.dns-host.net."])
            response.flags |= dns.flags.AA
            return response

        reply = dv.read_answer(flagged(dns.message.make_query(RECORD, "TXT")), name(RECORD), name("com."))
        self.assertIsInstance(reply, dv.Referral)
        self.assertEqual(reply.zone, name("example.com."))

    def test_a_delegation_with_the_aa_flag_is_followed(self):
        def flagged(question):
            response = refer(question, "example.com.", ["ns1.dns-host.net.", "ns2.dns-host.net."])
            response.flags |= dns.flags.AA
            return response

        network = FakeNetwork().zone("example.com.", {
            "ns1.dns-host.net.": ("192.0.2.1", has(VALUE)), "ns2.dns-host.net.": ("192.0.2.2", has(VALUE)),
        })
        del network.zones["example.com."]  # com's servers delegate it as scripted below
        for address in ("203.0.113.1", "203.0.113.2", "203.0.113.3"):
            network.servers[address] = flagged
        result = verify(network)
        self.assertEqual((result.outcome, result.evidence["zone"]), (dv.VERIFIED, "example.com"))

    def test_a_failure_without_a_question_is_still_the_failure(self):
        response = dns.message.make_response(dns.message.make_query(RECORD, "TXT"))
        response.set_rcode(dns.rcode.SERVFAIL)
        response.question = []
        self.assertEqual(dv.read_answer(response, name(RECORD), name("example.com.")), dv.SERVER_FAILURE)

    def test_name_servers_named_outside_their_zone_get_their_own_zones_addresses_not_the_resolvers(self):
        network = FakeNetwork(glue=False).zone("example.com.", three(has(VALUE)))
        network.resolved["ns1.dns-host.net."] = ["198.51.100.66"]  # never asked of the resolver
        self.assertEqual(verify(network).outcome, dv.VERIFIED)
        self.assertNotIn("ns1.dns-host.net.", network.looked_up)
        self.assertNotIn("198.51.100.66", network.asked)

    def test_name_servers_named_inside_their_zone_without_glue_are_not_looked_up(self):
        network = FakeNetwork(glue=False).zone("example.com.", {
            "ns1.example.com.": ("192.0.2.41", has(VALUE)), "ns2.example.com.": ("192.0.2.42", has(VALUE)),
        })
        result = verify(network)
        self.assertEqual((result.outcome, result.detail), (dv.INDETERMINATE, dv.NO_PUBLIC_NAMESERVERS))
        self.assertNotIn("ns1.example.com.", network.looked_up)
        self.assertEqual(network.asked_in("example.com."), [])

    def test_glue_outside_the_delegated_zone_is_ignored(self):
        def with_stray_glue(question):
            return refer(question, "example.com.", ["ns1.dns-host.net."], [("ns1.dns-host.net.", "192.0.2.99")])

        network = FakeNetwork().zone("example.com.", {"ns1.dns-host.net.": ("192.0.2.1", has(VALUE))})
        del network.zones["example.com."]  # com's servers delegate it as scripted below
        for address in ("203.0.113.1", "203.0.113.2", "203.0.113.3"):
            network.servers[address] = with_stray_glue
        self.assertEqual(verify(network).outcome, dv.VERIFIED)
        self.assertNotIn("192.0.2.99", network.asked)
        self.assertNotIn("ns1.dns-host.net.", network.looked_up)  # its own zone gave its address

    def test_a_delegation_a_server_may_not_make_is_malformed(self):
        def elsewhere(question):
            return refer(question, "attacker.net.", ["ns.attacker.net."])

        network = FakeNetwork().zone("example.com.", three(elsewhere))
        self.assertEqual(verify(network).detail, dv.MALFORMED_RESPONSE)

    def test_the_suffix_servers_must_agree_on_the_delegation(self):
        network = FakeNetwork().zone("example.com.", three(has(VALUE)))
        network.servers["203.0.113.2"] = nxdomain  # one server of com does not know the domain
        network.server_zone["203.0.113.2"] = "orphan."
        network.zones["orphan."] = []
        self.assertEqual(verify(network).outcome, dv.PROPAGATION_PENDING)

    def test_name_servers_without_public_dns_are_never_looked_up_nor_asked(self):
        network = FakeNetwork(glue=False).zone("example.com.", {
            "ns1.corp.internal.": ("192.0.2.1", has(VALUE)),
            "ns2.router.local.": ("192.0.2.2", has(VALUE)),
        })
        result = verify(network)
        self.assertEqual((result.outcome, result.detail), (dv.INDETERMINATE, dv.NO_PUBLIC_NAMESERVERS))
        self.assertEqual([host for host in network.looked_up if host.endswith((".internal.", ".local."))], [])
        self.assertEqual(network.asked_in("example.com."), [])


class NameServerAddressTests(SimpleTestCase):
    """The addresses of name servers named outside the zone they serve: found from their own zone,
    the way the record is; never the resolver's, and nothing at all rather than a doubtful one."""

    ATTACKER = "198.51.100.66"

    def hosted(self, provider_servers, *, glue=True):
        """example.com on ns1-3.dns-host.net; dns-host.net served by ``provider_servers``."""
        network = FakeNetwork(glue=glue).zone("example.com.", three(has(VALUE)))
        network.zone("dns-host.net.", provider_servers)
        # The record's servers' names are dns-host.net's data now, not the TLD's.
        network.servers[self.ATTACKER] = has(VALUE)
        network.server_zone[self.ATTACKER] = "example.com."
        for host in ("ns1.dns-host.net.", "ns2.dns-host.net.", "ns3.dns-host.net."):
            network.resolved[host] = [self.ATTACKER]  # what a poisoned resolver would say
        return network

    def provider(self, third=None):
        servers = {
            "a.hostdns.org.": ("192.0.2.91", absent), "b.hostdns.org.": ("192.0.2.92", absent),
            "c.hostdns.org.": ("192.0.2.93", absent),
        }
        return servers

    def test_the_original_attack_a_taken_over_server_shared_by_the_owners_zones(self):
        # example.com and example.net are both on ns1/ns2.example.net and ns.lapsed.org, taken over:
        # it answers for the other two's addresses with its own, and the resolver would believe it.
        for glue in (True, False):  # their addresses from .net's glue, or from example.net's servers
            with self.subTest(glue=glue):
                network = FakeNetwork(glue=glue)
                shared = {
                    "ns1.example.net.": ("192.0.2.1", absent), "ns2.example.net.": ("192.0.2.2", absent),
                    "ns.lapsed.org.": ("198.51.100.9", has(VALUE)),
                }
                network.zone("example.net.", dict(shared))
                network.zone("example.com.", dict(shared))
                network.address_answers["198.51.100.9"] = lambda question: _addresses(question, [self.ATTACKER])
                network.servers[self.ATTACKER] = has(VALUE)
                network.server_zone[self.ATTACKER] = "example.com."
                for host in ("ns1.example.net.", "ns2.example.net."):
                    network.resolved[host] = [self.ATTACKER]
                result = verify(network)
                self.assertNotEqual(result.outcome, dv.VERIFIED)
                self.assertNotIn(self.ATTACKER, network.asked)
                self.assertNotIn("ns1.example.net.", network.looked_up)
                if not glue:
                    # The rogue was asked for their addresses, and was alone: none were used.
                    self.assertIn("198.51.100.9", network.asked)
                    self.assertEqual(result.detail, dv.INSUFFICIENT_COVERAGE)

    def test_one_taken_over_server_of_the_name_servers_zone_cannot_choose_their_addresses(self):
        network = self.hosted(self.provider(), glue=False)
        network.address_answers["192.0.2.93"] = lambda question: _addresses(question, [self.ATTACKER])
        result = verify(network)
        self.assertEqual((result.outcome, result.detail), (dv.INDETERMINATE, dv.NO_PUBLIC_NAMESERVERS))
        self.assertNotIn(self.ATTACKER, network.asked)

    def test_one_server_alone_answering_for_the_name_servers_zone_is_not_enough(self):
        servers = self.provider()
        servers["a.hostdns.org."] = ("192.0.2.91", fails(dns.exception.Timeout()))
        servers["b.hostdns.org."] = ("192.0.2.92", fails(dns.exception.Timeout()))
        network = self.hosted(servers, glue=False)
        network.address_answers["192.0.2.93"] = lambda question: _addresses(question, [self.ATTACKER])
        result = verify(network)
        self.assertEqual(result.detail, dv.NO_PUBLIC_NAMESERVERS)
        self.assertNotIn(self.ATTACKER, network.asked)

    def test_a_failed_lookup_is_never_replaced_by_the_resolvers_answer(self):
        servers = {host: (address, fails(dns.exception.Timeout())) for host, (address, _) in self.provider().items()}
        network = self.hosted(servers, glue=False)
        result = verify(network)
        self.assertEqual((result.outcome, result.detail), (dv.INDETERMINATE, dv.NO_PUBLIC_NAMESERVERS))
        self.assertEqual([host for host in network.looked_up if "dns-host" in host], [])
        self.assertNotIn(self.ATTACKER, network.asked)

    def test_a_poisoned_resolver_is_never_asked_for_the_name_servers(self):
        network = self.hosted(self.provider(), glue=False)
        result = verify(network)
        self.assertEqual(result.outcome, dv.VERIFIED)  # through the provider's own zone
        self.assertEqual([host for host in network.looked_up if "dns-host" in host], [])
        self.assertNotIn(self.ATTACKER, network.asked)

    def test_providers_whose_name_servers_are_in_their_own_zone_with_glue(self):
        # Cloudflare, Route 53, Azure: ns-1.provider-dns.org, its zone on its own names, with glue.
        network = FakeNetwork().zone("example.com.", {
            "ns-1.provider-dns.org.": ("192.0.2.101", has(VALUE)), "ns-2.provider-dns.org.": ("192.0.2.102", has(VALUE)),
        })
        network.zone("provider-dns.org.", {
            "ns-1.provider-dns.org.": ("192.0.2.101", has(VALUE)), "ns-2.provider-dns.org.": ("192.0.2.102", has(VALUE)),
        })
        network.server_zone["192.0.2.101"] = network.server_zone["192.0.2.102"] = "example.com."
        self.assertEqual(verify(network).outcome, dv.VERIFIED)
        self.assertEqual([host for host in network.looked_up if "provider-dns" in host], [])

    def test_providers_whose_zones_lean_on_each_other(self):
        # Hetzner: three zones, each served by the three servers, each named in one of them (with glue).
        servers = {
            "ns.second-ns.com.": ("192.0.2.111", has(VALUE)), "ns3.second-ns.org.": ("192.0.2.112", has(VALUE)),
            "ns1.your-server.net.": ("192.0.2.113", has(VALUE)),
        }
        network = FakeNetwork().zone("example.com.", dict(servers))
        for zone in ("second-ns.com.", "second-ns.org.", "your-server.net."):
            network.zone(zone, dict(servers))
        for address in ("192.0.2.111", "192.0.2.112", "192.0.2.113"):
            network.server_zone[address] = "example.com."
        self.assertEqual(verify(network).outcome, dv.VERIFIED)

    def test_providers_whose_zone_is_served_by_another_providers_names(self):
        # Namecheap, OVH: the provider's zone is on servers named in yet another zone (two levels).
        network = FakeNetwork().zone("example.com.", {
            "dns1.registrar-dns.com.": ("192.0.2.121", has(VALUE)), "dns2.registrar-dns.com.": ("192.0.2.122", has(VALUE)),
        })
        network.zone("registrar-dns.com.", {
            "a.ultra-dns.net.": ("192.0.2.131", absent), "b.ultra-dns.net.": ("192.0.2.132", absent),
        })
        network.zone("ultra-dns.net.", {
            "a.ultra-dns.net.": ("192.0.2.131", absent), "b.ultra-dns.net.": ("192.0.2.132", absent),
        })
        network.hosts["dns1.registrar-dns.com."]["A"] = ["192.0.2.121"]
        network.hosts["dns2.registrar-dns.com."]["A"] = ["192.0.2.122"]
        result = verify(network)
        self.assertEqual(result.outcome, dv.VERIFIED)
        self.assertEqual([host for host in network.looked_up if "dns" in host and "servers" not in host], [])

    def test_lookups_go_no_deeper_than_max_depth(self):
        # ns.l1-dns.com's zone is served by ns.l2-dns.com, whose zone by ns.l3-dns.com, glued in its own.
        network = FakeNetwork().zone("example.com.", {"ns.l1-dns.com.": ("192.0.2.141", has(VALUE))})
        network.zone("l1-dns.com.", {"ns.l2-dns.com.": ("192.0.2.142", absent)})
        network.zone("l2-dns.com.", {"ns.l3-dns.com.": ("192.0.2.143", absent)})
        network.zone("l3-dns.com.", {"ns.l3-dns.com.": ("192.0.2.143", absent)})
        network.server_zone["192.0.2.141"] = "example.com."
        self.assertEqual(verify(network, limits=dv.Limits(max_depth=2)).detail, dv.NO_PUBLIC_NAMESERVERS)
        self.assertEqual(verify(network, limits=dv.Limits(max_depth=3)).outcome, dv.VERIFIED)

    def test_a_lookup_cut_short_is_not_remembered_as_having_no_address(self):
        # ns.h-dns.com is first needed deep in another name server's chain, where the depth limit
        # cuts it short; asked for again at the top, it must be found, whatever the names' order.
        for first in ("ns.a-dns.com.", "ns.z-dns.com."):
            with self.subTest(first=first):
                network = FakeNetwork()
                network.zone("k-dns.com.", {"ns.k-dns.com.": ("192.0.2.14", absent)})
                network.zone("h-dns.com.", {"ns.k-dns.com.": ("192.0.2.14", absent)})
                network.zone("b-dns.com.", {"ns.h-dns.com.": ("192.0.2.13", absent)})
                network.zone(first.split(".", 1)[1], {"ns.b-dns.com.": ("192.0.2.12", absent)})
                network.zone("g-dns.com.", {"ns.g-dns.com.": ("192.0.2.11", absent)})
                network.zone("example.com.", {
                    first: ("192.0.2.10", fails(dns.exception.Timeout())),
                    "ns.g-dns.com.": ("192.0.2.11", has(VALUE)), "ns.h-dns.com.": ("192.0.2.13", has(VALUE)),
                })
                self.assertEqual(verify(network).outcome, dv.VERIFIED)

    def test_an_address_that_did_not_answer_is_not_asked_again(self):
        network = FakeNetwork().zone("example.com.", three(has(VALUE), provider="dns-host.com"))
        network.servers["203.0.113.1"] = fails(dns.exception.Timeout())  # a server of com, asked often
        result = verify(network)
        self.assertEqual(result.outcome, dv.VERIFIED)
        self.assertEqual(network.asked.count("203.0.113.1"), 1)

    def test_zones_that_only_name_each_others_servers_without_glue_are_not_resolved(self):
        network = FakeNetwork(glue=False).zone("example.com.", {"ns.a-dns.com.": ("192.0.2.151", has(VALUE))})
        network.zone("a-dns.com.", {"ns.b-dns.com.": ("192.0.2.152", absent)})
        network.zone("b-dns.com.", {"ns.a-dns.com.": ("192.0.2.151", absent)})
        network.server_zone["192.0.2.151"] = "example.com."
        result = verify(network)
        self.assertEqual(result.detail, dv.NO_PUBLIC_NAMESERVERS)

    def test_ipv6_only_name_servers(self):
        network = FakeNetwork(glue=False).zone("example.com.", {
            "ns1.v6-dns.net.": ("2001:db8::161", has(VALUE)), "ns2.v6-dns.net.": ("2001:db8::162", has(VALUE)),
        })
        result = verify(network)
        self.assertEqual(result.outcome, dv.VERIFIED)
        self.assertEqual({server["address"] for server in result.evidence["nameservers"]}, {"2001:db8::161", "2001:db8::162"})

    def test_ipv4_first_then_ipv6(self):
        network = FakeNetwork(glue=False).zone("example.com.", {
            "ns1.dual-dns.net.": [("192.0.2.171", fails(dns.exception.Timeout())), ("2001:db8::171", has(VALUE))],
            "ns2.dual-dns.net.": [("192.0.2.172", has(VALUE)), ("2001:db8::172", has(VALUE))],
        })
        result = verify(network)
        self.assertEqual(result.outcome, dv.VERIFIED)
        self.assertEqual(network.asked_in("example.com."), ["192.0.2.171", "2001:db8::171", "192.0.2.172"])


def _addresses(question, addresses):
    """An authoritative answer to an address question with ``addresses`` (of the asked kind)."""
    response = respond(question)
    qname, rdtype = question.question[0].name, question.question[0].rdtype
    family = "AAAA" if rdtype == dns.rdatatype.AAAA else "A"
    chosen = [address for address in addresses if (":" in address) == (family == "AAAA")]
    if chosen:
        response.answer.append(dns.rrset.from_text_list(qname, 300, "IN", family, chosen))
    return response


class AliasTests(SimpleTestCase):
    def test_a_cname_is_followed_from_its_own_suffix(self):
        network = FakeNetwork().zone("example.com.", three(alias("verify.provider.net.")))
        network.zone("provider.net.", {
            "a.provider.net.": ("198.51.100.10", has(VALUE)), "b.provider.net.": ("198.51.100.11", has(VALUE)),
        })
        result = verify(network)
        self.assertEqual((result.outcome, result.detail), (dv.VERIFIED, dv.FOUND))
        self.assertEqual(result.evidence["aliases"], ["verify.provider.net"])
        self.assertEqual(result.evidence["zone"], "provider.net")

    def test_a_cname_from_a_subzone_into_its_parent_zone(self):
        network = FakeNetwork().zone("example.com.", three(by_name({"v.example.com.": has(VALUE)})))
        network.zone("shop.example.com.", {
            "ns1.shop.example.com.": ("192.0.2.31", alias("v.example.com.")),
            "ns2.shop.example.com.": ("192.0.2.32", alias("v.example.com.")),
        })
        result = dv.verify("shop.example.com", [VALUE], network=network, allowed=allow_documentation)
        self.assertEqual((result.outcome, result.evidence["zone"]), (dv.VERIFIED, "example.com"))

    def test_servers_that_alias_to_different_places_disagree(self):
        network = FakeNetwork().zone("example.com.", three(alias("a.example.net."), alias("b.example.net.")))
        self.assertEqual(verify(network).outcome, dv.PROPAGATION_PENDING)

    def test_an_alias_and_a_record_disagree(self):
        network = FakeNetwork().zone("example.com.", three(alias("a.example.net."), has(VALUE)))
        self.assertEqual(verify(network).outcome, dv.PROPAGATION_PENDING)

    def test_a_dname_above_the_name_is_followed(self):
        network = FakeNetwork().zone("example.com.", three(answers(dname=("example.com.", "example.org."))))
        network.zone("example.org.", {"ns.dns-host.net.": ("192.0.2.50", has(VALUE))})
        result = verify(network)
        self.assertEqual(result.outcome, dv.VERIFIED)
        self.assertEqual(result.evidence["aliases"], ["_ssphere-sentinel.example.org"])

    def test_an_alias_loop_ends(self):
        network = FakeNetwork().zone("example.com.", three(alias("x.example.net.")))
        network.zone("example.net.", {"ns.dns-host.org.": ("192.0.2.60", alias(RECORD))})
        result = verify(network)
        self.assertEqual((result.outcome, result.detail), (dv.INDETERMINATE, dv.ALIAS_LOOP))

    def test_a_chain_of_aliases_is_bounded(self):
        network = FakeNetwork().zone("example.com.", three(alias("hop0.example.net.")))
        network.zone("example.net.", {"ns.dns-host.org.": ("192.0.2.70", by_name(
            {f"hop{hop}.example.net.": alias(f"hop{hop + 1}.example.net.") for hop in range(20)}
        ))})
        result = verify(network, limits=dv.Limits(max_aliases=3))
        self.assertEqual((result.outcome, result.detail), (dv.INDETERMINATE, dv.TOO_MANY_ALIASES))
        self.assertEqual(len(result.evidence["aliases"]), 3)

    def test_an_alias_to_a_name_without_public_dns_ends_it(self):
        for target in ("x.corp.internal.", "printer.local.", "1.0.0.10.in-addr.arpa.", "host.notatld."):
            with self.subTest(target=target):
                network = FakeNetwork().zone("example.com.", three(alias(target)))
                result = verify(network)
                self.assertEqual((result.outcome, result.detail), (dv.INDETERMINATE, dv.ALIAS_NOT_PUBLIC))
                self.assertEqual(set(network.zones_asked), {"com.", "net."})  # the name servers' suffixes only

    def test_an_alias_with_a_record_beside_it_is_malformed(self):
        def both(question):
            response = respond(question, txt=[[VALUE]])
            response.answer.append(dns.rrset.from_text(question.question[0].name, 300, "IN", "CNAME", "x.example.net."))
            return response

        self.assertEqual(verify(FakeNetwork().zone("example.com.", three(both))).detail, dv.MALFORMED_RESPONSE)


class BoundaryTests(SimpleTestCase):
    def test_name_servers_at_addresses_that_are_not_public_are_never_asked(self):
        network = FakeNetwork(glue=False).zone("example.com.", {
            "ns1.dns-host.net.": ("10.0.0.53", has(VALUE)),
            "ns2.dns-host.net.": ("127.0.0.1", has(VALUE)),
            "ns3.dns-host.net.": [("169.254.169.254", has(VALUE)), ("::ffff:10.0.0.1", has(VALUE))],
        })
        result = verify(network, allowed=lambda address: dv.public_address(address) or address.startswith("203.0.113."))
        self.assertEqual((result.outcome, result.detail), (dv.INDETERMINATE, dv.NO_PUBLIC_NAMESERVERS))
        self.assertEqual(network.asked_in("example.com."), [])

    def test_public_addresses(self):
        for address in ("8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"):
            with self.subTest(address=address):
                self.assertTrue(dv.public_address(address))
        for address in (
            "10.1.2.3", "172.16.0.1", "192.168.1.1", "127.0.0.1", "0.0.0.0", "169.254.169.254", "100.64.0.1",
            "100.100.100.200", "192.0.0.192", "192.0.2.1", "198.18.0.1", "192.88.99.1", "224.0.0.251",
            "240.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fec0::1", "fec0:0:0:ffff::1", "fc00::1",
            "fd00:ec2::254", "ff02::1", "2001:db8::1", "2001:2::1", "4000::1", "::ffff:8.8.8.8", "::ffff:10.0.0.1",
            "::8.8.8.8", "64:ff9b::a00:1", "64:ff9b::808:808", "2002:a00:1::1", "2001:0:4136:e378::1",
            "not-an-address", "", "8.8.8.8:53",
        ):
            with self.subTest(address=address):
                self.assertFalse(dv.public_address(address))

    def test_the_number_of_questions_is_bounded(self):
        timeout = fails(dns.exception.Timeout())
        servers = {f"ns{n}.dns-host.net.": [(f"192.0.2.{n}", timeout), (f"2001:db8::{n}", timeout)] for n in range(1, 9)}
        network = FakeNetwork().zone("example.com.", servers)
        result = verify(network, limits=dv.Limits(max_operations=16))
        self.assertEqual((result.outcome, result.detail), (dv.INDETERMINATE, dv.QUERY_LIMIT))
        self.assertLessEqual(len(network.asked) + len(network.looked_up) + len(network.zones_asked), 16 + 1)

    def test_the_number_of_delegations_is_bounded(self):
        network = FakeNetwork().zone("example.com.", three(absent))
        zone = "example.com."
        for depth in range(6):
            zone = f"l{depth}.{zone}"
            network.zone(zone, {f"ns.{zone}": (f"192.0.2.{150 + depth}", absent)})
        deep = zone.rstrip(".")
        self.assertEqual(dv.verify(deep, [VALUE], network=network, allowed=allow_documentation).outcome, dv.ABSENT)
        result = dv.verify(deep, [VALUE], network=network, allowed=allow_documentation, limits=dv.Limits(max_referrals=3))
        self.assertEqual(result.detail, dv.QUERY_LIMIT)

    def test_the_whole_verification_has_one_deadline(self):
        now = [0.0]

        def slow(question):
            now[0] += 4.0
            raise dns.exception.Timeout

        network = FakeNetwork().zone("example.com.", three(slow))
        result = verify(network, limits=dv.Limits(deadline=10.0), clock=lambda: now[0])
        self.assertEqual((result.outcome, result.detail), (dv.INDETERMINATE, dv.TIMEOUT))
        self.assertLessEqual(len(network.asked_in("example.com.")), 3)

    def test_each_question_gets_at_most_what_is_left(self):
        timeouts = []
        now = [0.0]

        class Recording(FakeNetwork):
            def ask(self, address, question, timeout, left):
                timeouts.append(timeout)
                now[0] += 1.5
                return super().ask(address, question, timeout, left)

        network = Recording().zone("example.com.", three(has(VALUE)))
        verify(network, limits=dv.Limits(deadline=8.0, query_timeout=3.0), clock=lambda: now[0])
        self.assertEqual(timeouts[0], 3.0)
        self.assertTrue(all(timeout <= 3.0 for timeout in timeouts))
        self.assertLess(timeouts[-1], 3.0)

    def test_the_suffix_servers_that_cannot_be_found(self):
        class Lost(FakeNetwork):
            def zone_of(self, query_name, timeout):
                raise dns.resolver.NoNameservers

        self.assertEqual(verify(Lost()).detail, dv.RESOLVER_FAILURE)

    def test_a_suffix_zone_without_name_servers(self):
        network = FakeNetwork()
        network.zones["com."] = []
        self.assertEqual(verify(network).detail, dv.NO_NAMESERVERS)

    def test_a_resolver_timeout(self):
        class Slow(FakeNetwork):
            def zone_of(self, query_name, timeout):
                raise dns.resolver.LifetimeTimeout(timeout=timeout, errors=[])

        self.assertEqual(verify(Slow()).detail, dv.TIMEOUT)

    def test_the_root_is_never_taken_for_the_suffix_zone(self):
        class Root(FakeNetwork):
            def zone_of(self, query_name, timeout):
                return dns.name.root

        network = Root()
        self.assertEqual(verify(network).detail, dv.RESOLVER_FAILURE)
        self.assertEqual(network.asked, [])


class _Handler(socketserver.BaseRequestHandler):
    def handle(self):
        server = self.server
        if isinstance(self.request, tuple):  # UDP
            data, sock = self.request
            question = dns.message.from_wire(data)
            response = respond(question, txt=server.records)
            wire = response.to_wire(max_size=65535)
            if len(wire) > 512:
                response = respond(question)
                response.flags |= dns.flags.TC
                wire = response.to_wire()
            server.udp_questions += 1
            sock.sendto(wire, self.client_address)
        else:  # TCP
            length = struct.unpack("!H", self.request.recv(2))[0]
            question = dns.message.from_wire(self.request.recv(length))
            wire = respond(question, txt=server.records).to_wire(max_size=65535)
            server.tcp_questions += 1
            self.request.sendall(struct.pack("!H", len(wire)) + wire)


class _Udp(socketserver.ThreadingUDPServer):
    allow_reuse_address = True


class _Tcp(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


class SocketTests(SimpleTestCase):
    """The real network code (``DnsNetwork.ask``) against a server on this host: truncation, then TCP."""

    def serve(self, records):
        tcp = _Tcp(("127.0.0.1", 0), _Handler)
        port = tcp.server_address[1]
        try:
            udp = _Udp(("127.0.0.1", port), _Handler)
        except OSError:
            tcp.server_close()
            self.skipTest("no free UDP port beside the TCP one")
        for server in (udp, tcp):
            server.records, server.udp_questions, server.tcp_questions = records, 0, 0
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
        return port, udp, tcp

    def network(self, port):
        resolver = dns.resolver.Resolver(configure=False)
        resolver.nameservers = ["127.0.0.1"]
        return dv.DnsNetwork(resolver=resolver, port=port)

    def question(self):
        return dns.message.make_query(RECORD, "TXT", use_edns=0, payload=1232, flags=0)

    def test_a_short_answer_comes_over_udp(self):
        port, udp, tcp = self.serve([[VALUE]])
        response = self.network(port).ask("127.0.0.1", self.question(), 2.0, lambda: 5.0)
        answer = dv.read_answer(response, name(RECORD), name("example.com."))
        self.assertIn(VALUE.encode(), answer.values)
        self.assertEqual((udp.udp_questions, tcp.tcp_questions), (1, 0))

    def test_a_truncated_answer_is_asked_again_over_tcp(self):
        records = [[f"filler-{n}-" + "x" * 40] for n in range(30)] + [[VALUE]]
        port, udp, tcp = self.serve(records)
        response = self.network(port).ask("127.0.0.1", self.question(), 2.0, lambda: 5.0)
        answer = dv.read_answer(response, name(RECORD), name("example.com."))
        self.assertIn(VALUE.encode(), answer.values)
        self.assertEqual((udp.udp_questions, tcp.tcp_questions), (1, 1))

    def test_no_time_left_for_tcp(self):
        records = [[f"filler-{n}-" + "x" * 40] for n in range(30)]
        port, _, tcp = self.serve(records)
        with self.assertRaises(dns.exception.Timeout):
            self.network(port).ask("127.0.0.1", self.question(), 2.0, lambda: 0.0)
        self.assertEqual(tcp.tcp_questions, 0)

    def test_a_server_that_does_not_answer_times_out(self):
        silent = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        silent.bind(("127.0.0.1", 0))
        self.addCleanup(silent.close)
        with self.assertRaises(dns.exception.Timeout):
            self.network(silent.getsockname()[1]).ask("127.0.0.1", self.question(), 0.3, lambda: 5.0)
