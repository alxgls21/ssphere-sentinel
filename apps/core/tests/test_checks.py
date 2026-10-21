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

    @override_settings(AGENT_TOKEN_PEPPER="a-real-random-pepper", ALLOWED_HOSTS=["sentinel.example.com"])
    def test_sane_configuration_has_no_sentinel_warnings(self):
        self.assertFalse({i for i in deploy_check_ids() if i.startswith("sentinel.")})

    @override_settings(SENTINEL_URL="http://192.168.1.10:8000")
    def test_a_plain_http_address_is_reported(self):
        self.assertIn("sentinel.W003", deploy_check_ids())

    @override_settings(SENTINEL_URL="https://sentinel.example.com", AGENT_TOKEN_PEPPER="a-real-random-pepper",
                       ALLOWED_HOSTS=["sentinel.example.com"])
    def test_an_https_address_is_not(self):
        self.assertNotIn("sentinel.W003", deploy_check_ids())

    def test_checks_only_run_in_deploy_mode(self):
        with override_settings(ALLOWED_HOSTS=["*"]):
            ids = {message.id for message in run_checks()}
        self.assertNotIn("sentinel.W002", ids)
