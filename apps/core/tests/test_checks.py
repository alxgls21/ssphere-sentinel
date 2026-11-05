from django.core.checks import run_checks
from django.test import SimpleTestCase, override_settings


def deploy_check_ids():
    return {message.id for message in run_checks(include_deployment_checks=True)}


class DeploymentCheckTests(SimpleTestCase):
    @override_settings(AGENT_TOKEN_PEPPER="change-me-to-a-long-random-pepper")
    def test_placeholder_pepper_is_reported(self):
        self.assertIn("sentinel.W001", deploy_check_ids())

    @override_settings(ALLOWED_HOSTS=["*"])
    def test_wildcard_allowed_hosts_is_reported(self):
        self.assertIn("sentinel.W002", deploy_check_ids())

    @override_settings(
        AGENT_TOKEN_PEPPER="a-real-random-pepper",
        ALLOWED_HOSTS=["sentinel.example.com"],
        SENTINEL_URL="https://sentinel.example.com",
        SENTINEL_HTTP_BIND="127.0.0.1",
    )
    def test_sane_configuration_has_no_sentinel_warnings(self):
        self.assertFalse({i for i in deploy_check_ids() if i.startswith("sentinel.")})

    @override_settings(SENTINEL_URL="http://192.168.1.10:8000")
    def test_a_plain_http_address_is_reported(self):
        self.assertIn("sentinel.W003", deploy_check_ids())

    @override_settings(SENTINEL_URL="https://sentinel.example.com", AGENT_TOKEN_PEPPER="a-real-random-pepper",
                       ALLOWED_HOSTS=["sentinel.example.com"])
    def test_an_https_address_is_not(self):
        self.assertNotIn("sentinel.W003", deploy_check_ids())

    @override_settings(SENTINEL_CONSOLE_URL_IGNORED=True, SENTINEL_URL="")
    def test_the_setting_earlier_releases_read_for_the_email_links_is_reported(self):
        self.assertIn("sentinel.W004", deploy_check_ids())

    @override_settings(SENTINEL_CONSOLE_URL_IGNORED=False)
    def test_without_it_there_is_nothing_to_report(self):
        self.assertNotIn("sentinel.W004", deploy_check_ids())

    def test_an_https_address_with_the_proxy_published_on_every_interface_is_reported(self):
        # Unset or empty: Compose publishes on 0.0.0.0 (compose.yml), plain HTTP around the TLS front end.
        for bind in ("", "0.0.0.0", "::", "[::]", "192.168.1.10", "localhost"):
            with self.subTest(bind=bind), override_settings(SENTINEL_URL="https://sentinel.example.com",
                                                              SENTINEL_HTTP_BIND=bind):
                messages = [m for m in run_checks(include_deployment_checks=True) if m.id == "sentinel.W005"]
                self.assertEqual(len(messages), 1)
                self.assertIn("SENTINEL_HTTP_BIND=127.0.0.1", messages[0].hint)

    def test_a_loopback_address_is_not(self):
        for bind in ("127.0.0.1", " 127.0.0.1 ", "127.0.0.2", "::1", "[::1]"):
            with self.subTest(bind=bind), override_settings(SENTINEL_URL="https://sentinel.example.com",
                                                              SENTINEL_HTTP_BIND=bind):
                self.assertNotIn("sentinel.W005", deploy_check_ids())

    def test_nor_is_a_plain_http_address_or_none(self):
        # http:// is a local-network installation, published on purpose (sentinel.W003 speaks for it).
        for url in ("http://192.168.1.10:8000", ""):
            with self.subTest(url=url), override_settings(SENTINEL_URL=url, SENTINEL_HTTP_BIND=""):
                self.assertNotIn("sentinel.W005", deploy_check_ids())

    @override_settings(SENTINEL_URL="https://sentinel.example.com", SENTINEL_HTTP_BIND="")
    def test_the_published_address_is_only_checked_in_deploy_mode(self):
        self.assertNotIn("sentinel.W005", {message.id for message in run_checks()})

    def test_checks_only_run_in_deploy_mode(self):
        with override_settings(ALLOWED_HOSTS=["*"]):
            ids = {message.id for message in run_checks()}
        self.assertNotIn("sentinel.W002", ids)
