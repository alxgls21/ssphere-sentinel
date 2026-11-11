"""A JSON body nested deeper than the interpreter can parse is a malformed request (400), not a server error.

``json.loads`` raises ``RecursionError`` for such a body, and that is not a ``ValueError``. How deep "too deep"
is depends on the Python version and on the stack of the thread, so these tests make the parser raise it.
"""

from unittest.mock import patch

from django.test import RequestFactory, SimpleTestCase

from apps.console import http, views
from apps.console.http import ApiError

TOO_DEEP = RecursionError("maximum recursion depth exceeded while decoding a JSON array from a unicode string")


class DeeplyNestedJsonTests(SimpleTestCase):
    def refusal(self, parse, module) -> ApiError:
        request = RequestFactory().post("/api/v1/console/x/", data="[[]]", content_type="application/json")
        with patch.object(module.json, "loads", side_effect=TOO_DEEP):
            with self.assertRaises(ApiError) as caught:
                parse(request)
        return caught.exception

    def test_a_write_body_that_cannot_be_parsed_is_a_bad_request(self):
        error = self.refusal(http.json_object, http)
        self.assertEqual((error.status, error.code), (400, "invalid_request"))

    def test_sign_in_credentials_that_cannot_be_parsed_are_a_bad_request(self):
        error = self.refusal(views._credentials, views)
        self.assertEqual((error.status, error.code), (400, "invalid_request"))
