import unittest

from agent.config import Config, load_config
from agent.errors import ConfigError


class ConfigTests(unittest.TestCase):
    def test_load_config_success(self):
        config = load_config(
            {
                "SENTINEL_URL": "https://sentinel.example.com/",
                "SENTINEL_AGENT_TOKEN": "secret-token",
            }
        )

        self.assertEqual(config.sentinel_url, "https://sentinel.example.com")
        self.assertEqual(config.agent_token, "secret-token")
        self.assertEqual(config.heartbeat_interval, 30)
        self.assertEqual(
            config.heartbeat_url,
            "https://sentinel.example.com/api/v1/agent/heartbeat/",
        )

    def test_credentials_in_url_are_rejected(self):
        for url in ("https://user:pass@sentinel.example.com", "https://token@sentinel.example.com"):
            with self.subTest(url=url):
                with self.assertRaises(ConfigError) as ctx:
                    load_config({"SENTINEL_URL": url, "SENTINEL_AGENT_TOKEN": "secret-token"})
                self.assertIn("must not contain credentials", str(ctx.exception))
                self.assertNotIn("pass", str(ctx.exception))

    def test_configurable_heartbeat_interval(self):
        config = load_config(
            {
                "SENTINEL_URL": "https://sentinel.example.com",
                "SENTINEL_AGENT_TOKEN": "secret-token",
                "SENTINEL_HEARTBEAT_INTERVAL": "15",
            }
        )
        self.assertEqual(config.heartbeat_interval, 15)

    def test_invalid_heartbeat_interval_rejected(self):
        for value in ("0", "-5", "abc", "1.5"):
            with self.subTest(value=value):
                with self.assertRaises(ConfigError) as ctx:
                    load_config(
                        {
                            "SENTINEL_URL": "https://sentinel.example.com",
                            "SENTINEL_AGENT_TOKEN": "secret-token",
                            "SENTINEL_HEARTBEAT_INTERVAL": value,
                        }
                    )
                self.assertIn("SENTINEL_HEARTBEAT_INTERVAL", str(ctx.exception))

    def test_missing_sentinel_url(self):
        with self.assertRaises(ConfigError) as ctx:
            load_config({"SENTINEL_AGENT_TOKEN": "secret-token"})
        self.assertIn("SENTINEL_URL", str(ctx.exception))

    def test_missing_agent_token(self):
        with self.assertRaises(ConfigError) as ctx:
            load_config({"SENTINEL_URL": "https://sentinel.example.com"})
        self.assertIn("SENTINEL_AGENT_TOKEN", str(ctx.exception))

    def test_a_token_with_whitespace_or_control_characters_is_refused_without_repeating_it(self):
        # A4: a token pasted over two lines reached the Authorization header, where http.client refused
        # it with a message that repeated it (escaped, so redaction missed it) at every heartbeat.
        for token in (
            "first-half\nsecond-half",
            "first-half\r\nsecond-half",
            "first-half second-half",
            "first-half\tsecond-half",
            "first-half\x00second-half",
            "first-half\x1bsecond-half",
            "first-half\x85second-half",
            "first-half second-half",
            "first-half​second-half",
        ):
            with self.subTest(token=repr(token)):
                with self.assertRaises(ConfigError) as ctx:
                    load_config(
                        {"SENTINEL_URL": "https://sentinel.example.com", "SENTINEL_AGENT_TOKEN": token}
                    )
                self.assertIn("SENTINEL_AGENT_TOKEN", str(ctx.exception))
                self.assertNotIn("first-half", str(ctx.exception))
                self.assertNotIn("second-half", str(ctx.exception))
        # What the server issues (secrets.token_urlsafe) is accepted.
        token = "Ab9-_xY" * 6
        config = load_config({"SENTINEL_URL": "https://sentinel.example.com", "SENTINEL_AGENT_TOKEN": token})
        self.assertEqual(config.agent_token, token)

    def test_the_token_is_not_in_the_repr_of_the_config(self):
        config = load_config(
            {"SENTINEL_URL": "https://sentinel.example.com", "SENTINEL_AGENT_TOKEN": "secret-token-value"}
        )
        self.assertNotIn("secret-token-value", repr(config))
        self.assertEqual(config.agent_token, "secret-token-value")

    def test_empty_values_are_rejected(self):
        with self.assertRaises(ConfigError):
            load_config(
                {
                    "SENTINEL_URL": "   ",
                    "SENTINEL_AGENT_TOKEN": "token",
                }
            )
        with self.assertRaises(ConfigError):
            load_config(
                {
                    "SENTINEL_URL": "https://sentinel.example.com",
                    "SENTINEL_AGENT_TOKEN": "",
                }
            )


if __name__ == "__main__":
    unittest.main()
