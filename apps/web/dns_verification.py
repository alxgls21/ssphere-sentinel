"""Whether a domain's DNS holds its verification record, asked of the domain's own name servers.

``verify(domain, values)`` looks for ``_ssphere-sentinel.<domain>`` TXT, and answers:

    verified             every authoritative server that answered holds one of ``values``,
                         and more than half of the zone's name servers answered
    absent               every one that answered says the record is not there (no such
                         name, no TXT, or TXT without the value), as many answered
    propagation_pending  they disagree: some have it and some do not, they point the
                         name to different places, or some delegate it and some answer:
                         a change still spreading
    indeterminate        nothing trustworthy either way: too few answered, they failed
                         (timeouts, SERVFAIL, REFUSED, answers that are neither
                         authoritative nor a delegation, answers that cannot be read),
                         an alias loop or an alias to a name with no public DNS, or a limit

How. The system's resolver (the operator's, never one a client names) is asked only
where a public suffix is served (``co.uk``, ``com``): its zone, its name servers and
their addresses. From there Sentinel follows the delegations itself, the way a
resolver does, without recursion:

1. ``referral_servers`` of the suffix's servers are asked the question. Each answers
   with a delegation of a zone closer to the name (its name servers, and their
   addresses if it gives them) or with an authoritative answer. A delegation is
   followed only as more than half of those asked give it, all the same one (a
   server that is also one of the delegated zone's may answer from it instead, if
   it confirms the same name servers with authority). The delegations followed are
   the parents', never a child's claim about itself, nor one server's: a server of
   the domain cannot add a name server to those asked, nor choose where the zone
   begins. A name server of a delegated zone is asked only at addresses found the
   same way, never at the resolver's: those (glue) more than half of the servers
   asked give with the delegation (or where it answered, when it confirmed); else,
   for one named outside the zone, those its own zone gives, looked up like the
   record (``secure_addresses``: its suffix down, the delegations agreed on, more
   than half of that zone's servers answering, all the same, at most ``max_depth``
   lookups deep). One named inside the zone without such glue, or whose lookup
   fails, has no address and is not asked: never a doubtful one instead.
2. The servers of the delegated zone (at most ``max_nameservers``) are asked in turn,
   down to the zone that answers. Every server of that zone is then asked, at its
   public addresses (IPv4 first, at most ``max_addresses``): an answer counts only
   with the AA flag, for exactly the question asked; the first valid answer of a
   server is its answer. "Enough" is more than half of all the zone's name servers:
   the names the delegation gives, each once whatever its case, and however many
   addresses it has. Those names are the parent's to give: no server of the zone can
   add a name, nor count twice by giving itself more addresses.
3. The values match exactly: each TXT record's strings joined, compared as bytes;
   other records are ignored, and several values may be there.
4. A CNAME at the name (or a DNAME above it), when every answering server gives the
   same target, is followed from that target's own public suffix, at most
   ``max_aliases`` times and never twice. A target with no public DNS (special use,
   or under no known suffix) ends it.

Nothing is sent to an address that is not public (private, loopback, link-local,
site-local, shared, reserved, multicast, outside 2000::/3, IPv4 inside IPv6), and the
names of name servers with no public DNS are not even looked up: a zone cannot make
Sentinel query an internal network. Each question is a new message, with its own ID,
TXT, EDNS with a 1232-byte UDP buffer, and again over TCP when the answer is truncated.

Everything is bounded: one deadline for the whole verification, a timeout per
question, a number of questions (resolver lookups and the name servers' addresses
included), delegations followed and lookups nested; an address that did not answer
is not asked again. A failure is never taken for absence. What is kept of it
(``Result.evidence``) is what the servers said, by category: names, addresses and
results, never their raw answers.
"""

from __future__ import annotations

import ipaddress
import time
from collections import Counter
from collections.abc import Callable, Collection, Iterable
from dataclasses import dataclass, field

import dns.exception
import dns.flags
import dns.message
import dns.name
import dns.query
import dns.rcode
import dns.rdatatype
import dns.resolver

from apps.web.domains import record_name, registrable

VERIFIED = "verified"
ABSENT = "absent"
PROPAGATION_PENDING = "propagation_pending"
INDETERMINATE = "indeterminate"
OUTCOMES: Collection[str] = (VERIFIED, ABSENT, PROPAGATION_PENDING, INDETERMINATE)

# Why: one per outcome for the first three, the cause for an indeterminate one.
FOUND = "found"
NOT_FOUND = "not_found"
SERVERS_DISAGREE = "servers_disagree"
INSUFFICIENT_COVERAGE = "insufficient_coverage"
NO_NAMESERVERS = "no_nameservers"
NO_PUBLIC_NAMESERVERS = "no_public_nameservers"
TIMEOUT = "timeout"
SERVER_FAILURE = "server_failure"
REFUSED = "refused"
NOT_AUTHORITATIVE = "not_authoritative"
NETWORK_ERROR = "network_error"
MALFORMED_RESPONSE = "malformed_response"
ALIAS_LOOP = "alias_loop"
TOO_MANY_ALIASES = "too_many_aliases"
ALIAS_NOT_PUBLIC = "alias_not_public"
QUERY_LIMIT = "query_limit"
RESOLVER_FAILURE = "resolver_failure"
INTERNAL_ERROR = "internal_error"

# Which cause speaks for a step where no server answered, most telling first.
ERROR_PRIORITY = (
    NOT_AUTHORITATIVE,
    REFUSED,
    SERVER_FAILURE,
    MALFORMED_RESPONSE,
    TIMEOUT,
    NETWORK_ERROR,
    NO_PUBLIC_NAMESERVERS,
)
# Per server, in the evidence: these and the error causes above.
MATCH = "match"
NO_MATCH = "no_match"
ALIAS = "alias"
REFERRAL = "referral"
NOT_ASKED = "not_asked"

_GLOBAL_UNICAST_V6 = ipaddress.ip_network("2000::/3")
# Addresses that are global unicast for ``ipaddress`` but carry or reach another network.
_EXCLUDED = tuple(
    ipaddress.ip_network(prefix)
    for prefix in ("192.88.99.0/24", "64:ff9b::/96", "64:ff9b:1::/48", "2001::/23", "2002::/16")
)


@dataclass(frozen=True)
class Limits:
    deadline: float = 30.0  # seconds, for the whole verification
    query_timeout: float = 3.0  # seconds, per question (UDP, then TCP, each)
    lookup_timeout: float = 5.0  # seconds, per resolver lookup
    max_operations: int = 256  # questions and lookups together, those of name servers' addresses included
    referral_servers: int = 3  # of the public suffix's servers, asked for the delegation
    max_nameservers: int = 13  # of a delegated zone
    max_addresses: int = 2  # per name server
    max_referrals: int = 8
    max_aliases: int = 8
    max_depth: int = 3  # name servers' addresses looked up for the lookup of name servers' addresses...
    udp_payload: int = 1232


LIMITS = Limits()


@dataclass(frozen=True)
class Result:
    outcome: str
    detail: str
    evidence: dict = field(default_factory=dict)


class _Glued(Exception):
    """A name server's addresses, given with a delegation more than half of the servers asked
    agreed on: the parent's word, as good as the delegation itself."""

    def __init__(self, addresses: set[str]):
        super().__init__()
        self.addresses = addresses


class Stop(Exception):
    """The verification ends here, with ``outcome`` (indeterminate unless said) for ``detail``."""

    def __init__(self, detail: str, outcome: str = INDETERMINATE, *, exhausted: bool = False):
        super().__init__(detail)
        self.detail = detail
        self.outcome = outcome
        # The verification's own time or questions ran out (not the servers' failure).
        self.exhausted = exhausted


@dataclass(frozen=True)
class Answer:
    """One server's authoritative answer: an alias, or the TXT values (empty: none)."""

    target: dns.name.Name | None = None
    values: frozenset[bytes] = frozenset()


@dataclass(frozen=True)
class Referral:
    """One server's delegation of ``zone``, closer to the name: its name servers, and the
    addresses given for those inside it."""

    zone: dns.name.Name
    hosts: frozenset[dns.name.Name]
    glue: frozenset[tuple[dns.name.Name, str]] = frozenset()


class Network:
    """What the verification asks of the network; tests replace it."""

    def zone_of(self, name: dns.name.Name, timeout: float) -> dns.name.Name:
        raise NotImplementedError

    def nameservers(self, zone: dns.name.Name, timeout: float) -> list[dns.name.Name]:
        raise NotImplementedError

    def addresses(self, host: dns.name.Name, rdtype: str, timeout: float) -> list[str]:
        raise NotImplementedError

    def ask(self, address: str, question: dns.message.Message, timeout: float, left: Callable[[], float]):
        raise NotImplementedError


class DnsNetwork(Network):
    """The real one: the system's resolver for where to start, then the servers themselves."""

    def __init__(self, limits: Limits = LIMITS, resolver: dns.resolver.Resolver | None = None, port: int = 53) -> None:
        self.port = port
        if resolver is None:
            resolver = dns.resolver.Resolver(configure=True)
            resolver.cache = None  # each verification sees the DNS as it is now
            resolver.use_edns(0, 0, limits.udp_payload)
        resolver.timeout = limits.query_timeout
        self.resolver = resolver

    def zone_of(self, name, timeout):
        return dns.resolver.zone_for_name(name, resolver=self.resolver, lifetime=timeout)

    def nameservers(self, zone, timeout):
        try:
            answer = self.resolver.resolve(zone, "NS", lifetime=timeout, search=False)
        except (dns.resolver.NoAnswer, dns.resolver.NXDOMAIN):
            return []
        return [rdata.target for rdata in answer]

    def addresses(self, host, rdtype, timeout):
        try:
            answer = self.resolver.resolve(host, rdtype, lifetime=timeout, search=False)
        except (dns.resolver.NoAnswer, dns.resolver.NXDOMAIN):
            return []
        return [rdata.address for rdata in answer]

    def ask(self, address, question, timeout, left):
        try:
            # A packet from the address that is not the answer (another ID, another question)
            # is ignored, not taken for the answer's failure.
            return dns.query.udp(
                question, address, timeout=timeout, port=self.port,
                ignore_unexpected=True, ignore_errors=True, raise_on_truncation=True,
            )
        except dns.message.Truncated:
            remaining = left()
            if remaining <= 0:
                raise dns.exception.Timeout from None
            return dns.query.tcp(question, address, timeout=min(timeout, remaining), port=self.port)


def public_address(text: str) -> bool:
    """Whether Sentinel may send a question to ``text``: a global unicast address, nothing else."""
    try:
        address = ipaddress.ip_address(text)
    except ValueError:
        return False
    if address.version == 6 and (
        address not in _GLOBAL_UNICAST_V6 or address.ipv4_mapped is not None or address.is_site_local
    ):
        return False
    if any(address in network for network in _EXCLUDED if network.version == address.version):
        return False
    return address.is_global and not (
        address.is_multicast or address.is_private or address.is_reserved or address.is_loopback
        or address.is_link_local or address.is_unspecified
    )


def public_name(name: dns.name.Name) -> bool:
    """Whether ``name`` is under a public suffix (so its DNS is public): a name server's or an alias's."""
    try:
        return registrable(name.to_text(omit_final_dot=True)) is not None
    except (UnicodeError, ValueError):
        return False


class _Budget:
    def __init__(self, limits: Limits, clock: Callable[[], float]) -> None:
        self.limits = limits
        self.clock = clock
        self.ends = clock() + limits.deadline
        self.operations = 0

    def left(self) -> float:
        return self.ends - self.clock()

    def take(self, per_operation: float) -> float:
        """The timeout for one more question or lookup, or :class:`Stop`."""
        left = self.left()
        if left <= 0:
            raise Stop(TIMEOUT, exhausted=True)
        if self.operations >= self.limits.max_operations:
            raise Stop(QUERY_LIMIT, exhausted=True)
        self.operations += 1
        return min(per_operation, left)


def _cause(error: BaseException) -> str:
    if isinstance(error, dns.exception.Timeout):
        return TIMEOUT
    if isinstance(error, (OSError, EOFError)):
        return NETWORK_ERROR
    return MALFORMED_RESPONSE


def _text(name: dns.name.Name) -> str:
    return name.to_text(omit_final_dot=True)


def _referral(response: dns.message.Message, question: dns.name.Name, zone: dns.name.Name) -> Referral | str:
    """A delegation, from a server of ``zone``, of a zone between it and the name; or why not."""
    cuts = [rrset for rrset in response.authority if rrset.rdtype == dns.rdatatype.NS]
    if response.rcode() != dns.rcode.NOERROR or response.answer or len(cuts) != 1:
        return NOT_AUTHORITATIVE
    cut = cuts[0].name
    if cut == zone or not cut.is_subdomain(zone) or not question.is_subdomain(cut):
        return MALFORMED_RESPONSE  # a delegation the server may not make, or of another name
    hosts = frozenset(rdata.target for rdata in cuts[0])
    glue = frozenset(
        (rrset.name, rdata.address)
        for rrset in response.additional
        if rrset.rdtype in (dns.rdatatype.A, dns.rdatatype.AAAA) and rrset.name in hosts and rrset.name.is_subdomain(cut)
        for rdata in rrset
    )
    return Referral(cut, hosts, glue)


def read_answer(
    response: dns.message.Message, question: dns.name.Name, zone: dns.name.Name, rdtype=dns.rdatatype.TXT
) -> Answer | Referral | str:
    """A server of ``zone``'s answer to ``question`` (TXT, or A/AAAA): an ``Answer``, a ``Referral``, or the
    cause it is neither. The values are each TXT record's strings joined, or the addresses."""
    rcode = response.rcode()
    if rcode == dns.rcode.SERVFAIL:
        return SERVER_FAILURE
    if rcode not in (dns.rcode.NOERROR, dns.rcode.NXDOMAIN):
        return REFUSED
    if len(response.question) != 1 or response.question[0].name != question:
        return MALFORMED_RESPONSE
    delegates = rcode == dns.rcode.NOERROR and not response.answer and not any(
        rrset.rdtype == dns.rdatatype.SOA for rrset in response.authority
    ) and any(rrset.rdtype == dns.rdatatype.NS and rrset.name != zone for rrset in response.authority)
    if not response.flags & dns.flags.AA or delegates:
        # A delegation, also from a server that sets AA on it.
        return _referral(response, question, zone)
    targets = set()
    values: set[bytes] = set()
    found = False
    for rrset in response.answer:
        if rrset.name == question and rrset.rdtype == dns.rdatatype.CNAME:
            targets.update(rdata.target for rdata in rrset)
        elif rrset.rdtype == dns.rdatatype.DNAME and question.is_subdomain(rrset.name) and question != rrset.name:
            for rdata in rrset:
                try:
                    targets.add(question.relativize(rrset.name).concatenate(rdata.target))
                except dns.name.NameTooLong:
                    return MALFORMED_RESPONSE
        elif rrset.name == question and rrset.rdtype == rdtype:
            found = True
            if rdtype == dns.rdatatype.TXT:
                values.update(b"".join(rdata.strings) for rdata in rrset)
            else:
                values.update(rdata.address.encode("ascii") for rdata in rrset)
    if len(targets) > 1 or (targets and found):
        return MALFORMED_RESPONSE  # an alias is the only record its name may have
    if targets:
        return Answer(target=targets.pop())
    return Answer(values=frozenset(values))


@dataclass
class _Server:
    name: dns.name.Name
    address: str | None = None
    result: str = NOT_ASKED
    reply: Answer | Referral | None = None

    def evidence(self) -> dict:
        return {"name": _text(self.name), "address": self.address, "result": self.result}


class _Lookups:
    """What a verification and the lookups of its name servers' addresses share: the network,
    one budget, and the addresses already found (or not), by name."""

    def __init__(self, network: Network, limits: Limits, clock: Callable[[], float], allowed: Callable[[str], bool]):
        self.network = network
        self.limits = limits
        self.budget = _Budget(limits, clock)
        self.allowed = allowed
        self.addresses: dict[dns.name.Name, list[str]] = {}
        self.resolving: set[dns.name.Name] = set()
        self.cut_short = 0  # lookups cut short: they needed themselves, or went too deep
        # The resolver's answers, asked once: the public suffixes' zones and servers, their addresses.
        self.suffixes: dict[dns.name.Name, tuple[dns.name.Name, list[dns.name.Name]]] = {}
        self.trusted: dict[dns.name.Name, list[str]] = {}
        # Addresses that did not answer in time, or could not be reached: not asked again.
        self.unreachable: dict[str, str] = {}


class _Verification:
    def __init__(self, lookups: _Lookups, depth: int = 0):
        self.lookups = lookups
        self.depth = depth
        self.network = lookups.network
        self.limits = lookups.limits
        self.budget = lookups.budget
        self.allowed = lookups.allowed
        self.zone: dns.name.Name | None = None
        self.servers: list[_Server] = []
        self.nameserver_count = 0
        self.aliases: list[str] = []

    def evidence(self) -> dict:
        return {
            "zone": _text(self.zone) if self.zone is not None else None,
            "aliases": self.aliases,
            "nameserverCount": self.nameserver_count,
            "nameservers": [server.evidence() for server in self.servers],
        }

    def run(self, name: dns.name.Name, wanted: frozenset[bytes]) -> tuple[str, str]:
        seen = {name}
        while True:
            answered = self.authoritative_answers(name)
            # More than half of the zone's name servers: the names its delegation gives.
            enough = 2 * len(answered) > self.nameserver_count
            targets = {server.reply.target for server in answered}
            if len(targets) > 1:
                return PROPAGATION_PENDING, SERVERS_DISAGREE
            target = targets.pop()
            if target is not None:
                for server in answered:
                    server.result = ALIAS
                if not enough:
                    return INDETERMINATE, INSUFFICIENT_COVERAGE
                if target in seen:
                    return INDETERMINATE, ALIAS_LOOP
                if len(self.aliases) >= self.limits.max_aliases:
                    return INDETERMINATE, TOO_MANY_ALIASES
                seen.add(target)
                self.aliases.append(_text(target))
                if not public_name(target):
                    return INDETERMINATE, ALIAS_NOT_PUBLIC
                name = target
                continue
            matches = 0
            for server in answered:
                found = bool(server.reply.values & wanted)
                server.result = MATCH if found else NO_MATCH
                matches += found
            if 0 < matches < len(answered):
                return PROPAGATION_PENDING, SERVERS_DISAGREE
            if not enough:
                return INDETERMINATE, INSUFFICIENT_COVERAGE
            return (VERIFIED, FOUND) if matches else (ABSENT, NOT_FOUND)

    def authoritative_answers(self, name: dns.name.Name, rdtype=dns.rdatatype.TXT) -> list[_Server]:
        """The servers of ``name``'s zone that answered ``rdtype`` with authority: found from the name's
        public suffix down, every delegation agreed on by more than half of those asked."""
        zone, hosts = self.suffix_servers(name)
        glue: dict[dns.name.Name, set[str]] = {}
        # The suffix's own servers come from the resolver with their addresses; a delegated
        # zone's servers named inside it have only the addresses its delegation agreed on.
        delegated = False
        asked = self.limits.referral_servers
        for _ in range(self.limits.max_referrals + 1):
            hosts = sorted(set(hosts))
            if not hosts:
                raise Stop(NO_NAMESERVERS)
            self.zone, self.nameserver_count = zone, len(hosts)
            self.servers = [_Server(host) for host in hosts[: min(asked, self.limits.max_nameservers)]]
            self.ask_each(self.servers, name, rdtype, zone, glue, delegated)
            if not any(server.reply is not None for server in self.servers):
                raise Stop(self.why_none_answered())
            if not any(isinstance(server.reply, Referral) for server in self.servers):
                # This zone answers: every one of its servers is asked.
                rest = [_Server(host) for host in hosts[len(self.servers) : self.limits.max_nameservers]]
                self.ask_each(rest, name, rdtype, zone, glue, delegated)
                self.servers += rest
            delegation = self.delegation()
            if delegation is None:
                return [server for server in self.servers if server.reply is not None]
            zone, hosts, glue = delegation
            if rdtype != dns.rdatatype.TXT and name in glue:
                raise _Glued(glue[name])  # the address asked for came with the delegation
            delegated = True
            asked = self.limits.max_nameservers
        raise Stop(QUERY_LIMIT)

    def delegation(self):
        """``(zone, hosts, glue)`` when this level's servers delegate the name, None when they answer it.

        A delegation is followed only as more than half of the servers asked give it, every
        one the same: the same zone and the same name servers, with the addresses for them
        that more than half of the servers asked give. A server that answers instead counts with
        them only when it is one of those name servers and confirms them with authority
        (a server of both zones answers from the closer one); none ever adds a server to
        who is asked next. One that says with authority there is no such zone, or a
        delegation that differs, is a change still spreading. A delegation to more servers
        than can all be asked concludes nothing.
        """
        referring = [server for server in self.servers if isinstance(server.reply, Referral)]
        if not referring:
            return None
        if len({(server.reply.zone, server.reply.hosts) for server in referring}) > 1:
            raise Stop(SERVERS_DISAGREE, PROPAGATION_PENDING)
        referral = referring[0].reply
        if len(referral.hosts) > self.limits.max_nameservers:
            raise Stop(INSUFFICIENT_COVERAGE)
        supporting = set(map(id, referring))
        confirming = []
        for server in self.servers:
            if isinstance(server.reply, Answer):
                confirmed = server.name in referral.hosts and self.confirms(server, referral)
                if confirmed is False:
                    raise Stop(SERVERS_DISAGREE, PROPAGATION_PENDING)
                if confirmed:
                    supporting.add(id(server))
                    confirming.append(server)
        if 2 * len(supporting) <= len(self.servers):
            raise Stop(INSUFFICIENT_COVERAGE)
        # The addresses more than half of the servers asked give: no one server's own.
        given = Counter(pair for server in referring for pair in server.reply.glue)
        glue: dict[dns.name.Name, set[str]] = {}
        for (host, address), count in given.items():
            if 2 * count > len(self.servers):
                glue.setdefault(host, set()).add(address)
        # A server that confirmed is asked again where it answered, as this level already trusted.
        for server in confirming:
            glue.setdefault(server.name, set()).add(server.address)
        return referral.zone, list(referral.hosts), glue

    def confirms(self, server: _Server, referral: Referral) -> bool | None:
        """Whether ``server`` serves the delegated zone with the delegation's name servers (asked
        for them): True when it gives the same ones with authority, False when it says with
        authority that the zone has none (no such zone there), None otherwise (it could not
        be asked, or the zone's own list differs from its parent's, which is common)."""
        question = dns.message.make_query(
            referral.zone, dns.rdatatype.NS, use_edns=0, payload=self.limits.udp_payload, flags=0
        )
        try:
            response = self.network.ask(
                server.address, question, self.budget.take(self.limits.query_timeout), self.budget.left
            )
        except Stop:
            raise
        except (dns.exception.DNSException, OSError, EOFError, ValueError):
            return None
        if (
            response.rcode() not in (dns.rcode.NOERROR, dns.rcode.NXDOMAIN)
            or not response.flags & dns.flags.AA
            or len(response.question) != 1
            or response.question[0].name != referral.zone
        ):
            return None
        for rrset in response.answer:
            if rrset.name == referral.zone and rrset.rdtype == dns.rdatatype.NS:
                return True if frozenset(rdata.target for rdata in rrset) == referral.hosts else None
        return False

    def suffix_servers(self, name: dns.name.Name) -> tuple[dns.name.Name, list[dns.name.Name]]:
        """The zone the name's public suffix is in, and its name servers, from the system's resolver."""
        base = registrable(_text(name))
        if base is None:
            raise Stop(ALIAS_NOT_PUBLIC)
        suffix = dns.name.from_text(base).parent()
        if suffix in self.lookups.suffixes:
            return self.lookups.suffixes[suffix]
        try:
            zone = self.network.zone_of(suffix, self.budget.take(self.limits.lookup_timeout))
            if zone == dns.name.root or not suffix.is_subdomain(zone):
                raise Stop(RESOLVER_FAILURE)
            hosts = self.network.nameservers(zone, self.budget.take(self.limits.lookup_timeout))
        except dns.exception.Timeout:
            raise Stop(TIMEOUT) from None
        except dns.exception.DNSException:
            raise Stop(RESOLVER_FAILURE) from None
        self.lookups.suffixes[suffix] = zone, hosts
        return zone, hosts

    def why_none_answered(self) -> str:
        causes = {server.result for server in self.servers}
        return next((cause for cause in ERROR_PRIORITY if cause in causes), INSUFFICIENT_COVERAGE)

    def ask_each(self, servers: list[_Server], name, rdtype, zone: dns.name.Name, glue: dict, delegated: bool):
        for server in servers:
            self.ask_server(server, name, rdtype, zone, glue, delegated)

    def ask_server(self, server: _Server, name, rdtype, zone: dns.name.Name, glue: dict, delegated: bool):
        addresses = self.addresses_of(server, zone, glue, delegated)
        if not addresses:
            server.result = NO_PUBLIC_NAMESERVERS
            return
        for address in addresses:
            server.address = address
            if address in self.lookups.unreachable:
                server.result = self.lookups.unreachable[address]
                continue
            # A new message each time: its own random ID.
            question = dns.message.make_query(
                name, rdtype, use_edns=0, payload=self.limits.udp_payload, flags=0  # no recursion
            )
            try:
                response = self.network.ask(
                    address, question, self.budget.take(self.limits.query_timeout), self.budget.left
                )
            except Stop:
                raise
            except (dns.exception.DNSException, OSError, EOFError, ValueError) as error:
                server.result = _cause(error)
                if server.result in (TIMEOUT, NETWORK_ERROR):
                    self.lookups.unreachable[address] = server.result
                continue
            reply = read_answer(response, name, zone, rdtype)
            if isinstance(reply, (Answer, Referral)):
                server.reply = reply
                server.result = REFERRAL if isinstance(reply, Referral) else NO_MATCH
                return
            server.result = reply

    def addresses_of(self, server: _Server, zone: dns.name.Name, glue: dict, delegated: bool) -> list[str]:
        """Up to ``max_addresses`` public addresses of the server, IPv4 first, or none.

        Those its delegation agreed on (glue). Without them: a name inside the delegated zone
        has none (any other source would be the zone's own servers, or its parent's, one of
        which could answer for the others); a name outside it, the addresses found the way the
        record is (``secure_addresses``), never the resolver's. Only the servers of a public
        suffix's zone, where every walk starts, have the resolver's addresses.
        """
        given = sorted((a for a in glue.get(server.name, ()) if self.allowed(a)), key=lambda a: (":" in a, a))
        if given:
            return given[: self.limits.max_addresses]
        if not public_name(server.name):
            return []
        if delegated:
            if server.name.is_subdomain(zone):
                return []
            return self.secure_addresses(server.name)[: self.limits.max_addresses]
        if server.name in self.lookups.trusted:
            return self.lookups.trusted[server.name]
        found: list[str] = []
        for rdtype in ("A", "AAAA"):
            if len(found) >= self.limits.max_addresses:
                break
            try:
                candidates = self.network.addresses(server.name, rdtype, self.budget.take(self.limits.lookup_timeout))
            except Stop:
                raise
            except dns.exception.DNSException:
                continue
            public = [address for address in sorted(set(candidates)) if self.allowed(address)]
            found += public[: self.limits.max_addresses - len(found)]
        self.lookups.trusted[server.name] = found
        return found

    def secure_addresses(self, host: dns.name.Name) -> list[str]:
        """``host``'s public addresses (IPv4 first): found from its public suffix down like the
        record, every delegation agreed on, as its parent gives them with a delegation (glue
        more than half of the servers asked agree on) or as its own zone's servers answer, more
        than half of them, all the same. None of a kind when that cannot be had (a failure, a
        disagreement, an alias, too deep, a name already being looked up); no address at all,
        and the server is not asked."""
        lookups = self.lookups
        if host in lookups.addresses:
            return lookups.addresses[host]
        if self.depth >= self.limits.max_depth or host in lookups.resolving:
            lookups.cut_short += 1
            return []
        lookups.resolving.add(host)
        cut_short = lookups.cut_short
        found: list[str] = []
        try:
            for rdtype in (dns.rdatatype.A, dns.rdatatype.AAAA):
                lookup = _Verification(lookups, self.depth + 1)
                try:
                    answered = lookup.authoritative_answers(host, rdtype)
                except _Glued as glued:
                    found = sorted((a for a in glued.addresses if self.allowed(a)), key=lambda a: (":" in a, a))
                    break  # both kinds came with it
                except Stop as stop:
                    if stop.exhausted:
                        raise  # the verification itself is out of time or questions
                    continue
                replies = {server.reply for server in answered}
                if len(replies) != 1 or 2 * len(answered) <= lookup.nameserver_count:
                    continue
                (reply,) = replies
                if reply.target is not None:
                    continue  # a name server's name may not be an alias
                found += sorted(value.decode("ascii") for value in reply.values if self.allowed(value.decode("ascii")))
        finally:
            lookups.resolving.discard(host)
        if lookups.cut_short == cut_short:
            lookups.addresses[host] = found  # a lookup cut short may find more from elsewhere
        return found


def verify(
    domain: str,
    values: Iterable[str],
    *,
    network: Network | None = None,
    limits: Limits = LIMITS,
    clock: Callable[[], float] = time.monotonic,
    allowed: Callable[[str], bool] = public_address,
) -> Result:
    """Look for any of ``values`` in ``_ssphere-sentinel.<domain>`` TXT (``domain`` already normalized)."""
    wanted = frozenset(value.encode("ascii") for value in values)
    verification = _Verification(_Lookups(network or DnsNetwork(limits), limits, clock, allowed))
    try:
        name = dns.name.from_text(record_name(domain), origin=dns.name.root)
        outcome, detail = verification.run(name, wanted)
    except Stop as stop:
        outcome, detail = stop.outcome, stop.detail
    return Result(outcome, detail, verification.evidence())
