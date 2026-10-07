from django.test import SimpleTestCase, override_settings

from apps.agents.tokens import hash_token


class AgentTokenHashingTests(SimpleTestCase):
    @override_settings(
        AGENT_TOKEN_PEPPER="test-pepper-a",
        SECRET_KEY="django-secret-a",
    )
    def test_hash_uses_agent_token_pepper_not_secret_key(self):
        digest = hash_token("example-raw-token")

        with self.settings(SECRET_KEY="django-secret-b"):
            digest_after_secret_change = hash_token("example-raw-token")

        with self.settings(AGENT_TOKEN_PEPPER="test-pepper-b"):
            digest_after_pepper_change = hash_token("example-raw-token")

        self.assertEqual(digest, digest_after_secret_change)
        self.assertNotEqual(digest, digest_after_pepper_change)
