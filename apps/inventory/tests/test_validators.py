from django.core.exceptions import ValidationError
from django.test import SimpleTestCase

from apps.inventory.validators import validate_management_address

VALID = (
    "192.0.2.1",
    "10.0.0.254",
    "127.0.0.1",
    "2001:db8::1",
    "::1",
    "router1",
    "core-sw-01.example.com",
    "a.b.c",
    "R1.Example.COM",
    "x" * 63,
    ".".join(["a" * 60] * 4),  # 243 characters
)

INVALID = {
    "empty": "",
    "only spaces": "   ",
    "leading space": " 192.0.2.1",
    "trailing space": "192.0.2.1 ",
    "inner space": "my router",
    "tab": "router\t1",
    "newline": "router\n",
    "semicolon": "router;reboot",
    "pipe": "router|cat",
    "ampersand": "a&b",
    "backtick": "`id`",
    "dollar": "$HOME",
    "angle brackets": "<router>",
    "quotes": "rou'ter",
    "double quote": 'rou"ter',
    "backslash": "router\\x",
    "slash (URL or path)": "http://router",
    "underscore": "my_router",
    "leading hyphen": "-router",
    "trailing hyphen": "router-",
    "leading dot": ".router",
    "trailing dot": "router.",
    "empty label": "a..b",
    "label over 63 characters": "x" * 64,
    "name over 253 characters": ".".join(["a" * 60] * 5),
    "over the field length": "a" * 256,
    "unspecified IPv4": "0.0.0.0",
    "unspecified IPv6": "::",
    "multicast IPv4": "224.0.0.1",
    "multicast IPv6": "ff02::1",
    "out-of-range octet": "256.1.1.1",
    "incomplete IPv4": "192.0.2",
    "all-digit name": "12345",
    "port suffix": "192.0.2.1:161",
    "not a string": None,
}


class ManagementAddressValidatorTests(SimpleTestCase):
    def test_valid_addresses_are_accepted(self):
        for value in VALID:
            with self.subTest(value=value):
                validate_management_address(value)

    def test_invalid_addresses_are_rejected(self):
        for label, value in INVALID.items():
            with self.subTest(case=label):
                with self.assertRaises(ValidationError) as caught:
                    validate_management_address(value)
                self.assertEqual(caught.exception.code, "invalid")
