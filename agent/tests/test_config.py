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
        self.assertEqual(
            config.heartbeat_url,
            "https://sentinel.example.com/api/v1/agent/heartbeat/",
        )

    def test_missing_sentinel_url(self):
        with self.assertRaises(ConfigError) as ctx:
            load_config({"SENTINEL_AGENT_TOKEN": "secret-token"})
        self.assertIn("SENTINEL_URL", str(ctx.exception))

    def test_missing_agent_token(self):
        with self.assertRaises(ConfigError) as ctx:
            load_config({"SENTINEL_URL": "https://sentinel.example.com"})
        self.assertIn("SENTINEL_AGENT_TOKEN", str(ctx.exception))

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
