"""Domain names as typed, normalized once; and the verification record's token."""

import math
import re
from collections import Counter

from django.test import SimpleTestCase

from apps.web.domains import (
    MAX_LENGTH,
    TOKEN_LENGTH,
    InvalidDomain,
    new_token,
    normalize,
    record_name,
    record_value,
)


class NormalizationTests(SimpleTestCase):
    def assertNormal(self, text, ascii_name, display=None):
        self.assertEqual(normalize(text), (ascii_name, display or ascii_name))

    def assertRefused(self, text, words):
        with self.assertRaises(InvalidDomain) as caught:
            normalize(text)
        self.assertIn(words, str(caught.exception))
        return caught.exception

    def test_registrable_domains_and_names_under_them(self):
        self.assertNormal("example.com", "example.com")
        self.assertNormal("example.co.uk", "example.co.uk")
        self.assertNormal("shop.example.co.uk", "shop.example.co.uk")
        self.assertNormal("a.b.c.example.com", "a.b.c.example.com")
        # Under a suffix of the list's PRIVATE section: the customer's own name there.
        self.assertNormal("customer.github.io", "customer.github.io")
        self.assertNormal("www.customer.github.io", "www.customer.github.io")

    def test_one_spelling_whatever_was_typed(self):
        for typed in ("Example.COM", "  example.com  ", "example.com.", "ＥＸＡＭＰＬＥ。ｃｏｍ", "example。com"):
            with self.subTest(typed=typed):
                self.assertNormal(typed, "example.com")

    def test_internationalized_names_are_kept_as_a_labels_and_shown_as_unicode(self):
        self.assertNormal("bücher.de", "xn--bcher-kva.de", "bücher.de")
        self.assertNormal("BÜCHER.DE", "xn--bcher-kva.de", "bücher.de")
        self.assertNormal("xn--bcher-kva.de", "xn--bcher-kva.de", "bücher.de")
        self.assertNormal("xn--bcher-KVA.de", "xn--bcher-kva.de", "bücher.de")
        self.assertNormal("例子.中国", "xn--fsqu00a.xn--fiqs8s", "例子.中国")
        # IDNA2008, non-transitional: ß stays ß (it is not ss).
        self.assertNormal("faß.de", "xn--fa-hia.de", "faß.de")
        self.assertNotEqual(normalize("faß.de"), normalize("fass.de"))
        # A decomposed é and the composed one are the same name.
        self.assertEqual(normalize("éxample.com"), normalize("éxample.com"))

    def test_ip_addresses_are_refused(self):
        for typed in ("192.0.2.1", "192.0.2.1.", "[2001:db8::1]", "2001:db8::1", "::1", "10.0.0.1"):
            with self.subTest(typed=typed):
                self.assertRefused(typed, "not an IP address")

    def test_single_labels_are_refused(self):
        for typed in ("localhost.", "intranet", "com"):
            with self.subTest(typed=typed):
                with self.assertRaises(InvalidDomain):
                    normalize(typed)

    def test_public_suffixes_of_both_sections_are_refused(self):
        for typed in ("co.uk", "com.au", "github.io", "blogspot.com", "xn--fiqs8s", "中国"):
            with self.subTest(typed=typed):
                with self.assertRaises(InvalidDomain) as caught:
                    normalize(typed)
                self.assertRegex(str(caught.exception), "public suffix|full domain name")

    def test_names_under_no_known_suffix_and_special_use_names_are_refused(self):
        self.assertRefused("example.notatld", "not under a known public domain suffix")
        for typed in ("printer.local", "app.test", "a.example", "x.invalid", "db.internal", "foo.localhost",
                      "abc.onion", "1.0.0.127.in-addr.arpa", "router.home.arpa", "thing.alt"):
            with self.subTest(typed=typed):
                self.assertRefused(typed, "special use")

    def test_invalid_labels_are_refused(self):
        for typed in ("-example.com", "example-.com", "ex_ample.com", "exa mple.com", "a..com", ".example.com",
                      "ab--cd.com", "exa\x00mple.com", "exam/ple.com", "user@example.com", "example.com:443",
                      "http://example.com", "*.example.com", "😀.com", "xn--ls8h.com", "a" * 64 + ".com"):
            with self.subTest(typed=typed):
                with self.assertRaises(InvalidDomain):
                    normalize(typed)

    def test_malformed_a_labels_are_refused(self):
        for typed in ("xn--zz.com", "xn--.com", "xn--a.com", "shop.xn--zz"):
            with self.subTest(typed=typed):
                self.assertRefused(typed, "not a valid domain name")

    def test_a_name_must_leave_room_for_the_record_label(self):
        labels = ["a" * 63, "b" * 63, "c" * 63]
        long_name = ".".join(labels) + ".com"  # 195 characters: fits
        self.assertEqual(normalize(long_name)[0], long_name)
        too_long = "d" * 40 + "." + long_name  # 235 + 1
        self.assertEqual(len(too_long), MAX_LENGTH + 1)
        self.assertRefused(too_long, "too long")
        self.assertEqual(normalize(too_long[1:])[0], too_long[1:])
        self.assertLessEqual(len(record_name(too_long[1:])), 253)

    def test_what_is_not_text_and_empty_text_are_refused(self):
        for value in (None, 42, ["example.com"], {"name": "example.com"}, "", "   ", "x" * 2000):
            with self.subTest(value=value if not isinstance(value, str) or len(value) < 10 else "long"):
                with self.assertRaises(InvalidDomain):
                    normalize(value)

    def test_a_refusal_never_echoes_the_name(self):
        error = self.assertRefused("<script>.notatld", "")
        self.assertNotIn("script", str(error))


class TokenTests(SimpleTestCase):
    def test_tokens_have_256_random_bits_in_url_safe_text(self):
        tokens = [new_token() for _ in range(2000)]
        self.assertEqual(len(set(tokens)), len(tokens))
        for token in tokens:
            self.assertEqual(len(token), TOKEN_LENGTH)
            self.assertRegex(token, r"^[A-Za-z0-9_-]+$")
        # 43 base64url characters carry 258 bits; the source is 32 random bytes.
        self.assertGreaterEqual(TOKEN_LENGTH * 6, 256)
        # Every character position spreads over the alphabet: nothing fixed, nothing counted.
        counts = Counter("".join(token[:42] for token in tokens))
        self.assertEqual(len(counts), 64)
        expected = 2000 * 42 / 64
        self.assertLess(max(abs(count - expected) for count in counts.values()), 6 * math.sqrt(expected))
        first = Counter(token[0] for token in tokens)
        self.assertGreater(len(first), 50)

    def test_the_record(self):
        self.assertEqual(record_name("xn--bcher-kva.de"), "_ssphere-sentinel.xn--bcher-kva.de")
        token = new_token()
        self.assertEqual(record_value(token), f"ssphere-verification={token}")
        self.assertTrue(re.fullmatch(r"ssphere-verification=[A-Za-z0-9_-]{43}", record_value(token)))
