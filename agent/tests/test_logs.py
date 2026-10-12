import io
import logging
import os
import tempfile
import unittest

from agent.logs import LOGGER_NAME, configure_logging


class ConfigureLoggingTests(unittest.TestCase):
    def setUp(self):
        self.logger = logging.getLogger(LOGGER_NAME)
        self.saved = (list(self.logger.handlers), self.logger.level, self.logger.propagate)

    def tearDown(self):
        handlers, level, propagate = self.saved
        self.logger.handlers = handlers
        self.logger.setLevel(level)
        self.logger.propagate = propagate

    def _log_all(self, environ, stream):
        configure_logging(environ, stream)
        for level in (logging.DEBUG, logging.INFO, logging.WARNING, logging.ERROR):
            self.logger.log(level, "message at %s", logging.getLevelName(level))

    def test_default_level_is_info_with_plain_format(self):
        stream = io.StringIO()
        self._log_all({}, stream)
        lines = stream.getvalue().splitlines()
        self.assertEqual(
            lines,
            ["INFO: message at INFO", "WARNING: message at WARNING", "ERROR: message at ERROR"],
        )

    def test_level_comes_from_the_environment(self):
        stream = io.StringIO()
        self._log_all({"SENTINEL_LOG_LEVEL": "debug"}, stream)
        self.assertIn("DEBUG: message at DEBUG", stream.getvalue())
        stream = io.StringIO()
        self._log_all({"SENTINEL_LOG_LEVEL": "WARNING"}, stream)
        self.assertNotIn("INFO", stream.getvalue())

    def test_invalid_level_falls_back_to_info_with_a_warning(self):
        stream = io.StringIO()
        self._log_all({"SENTINEL_LOG_LEVEL": "chatty"}, stream)
        output = stream.getvalue()
        self.assertIn("WARNING: SENTINEL_LOG_LEVEL must be one of", output)
        self.assertIn("INFO: message at INFO", output)
        self.assertNotIn("message at DEBUG", output)

    def test_journald_gets_syslog_priority_prefixes(self):
        with tempfile.TemporaryFile("w+") as stream:
            stat = os.fstat(stream.fileno())
            environ = {"JOURNAL_STREAM": f"{stat.st_dev}:{stat.st_ino}"}
            self._log_all(environ, stream)
            stream.seek(0)
            lines = stream.read().splitlines()
        self.assertEqual(
            lines,
            ["<6>INFO: message at INFO", "<4>WARNING: message at WARNING", "<3>ERROR: message at ERROR"],
        )

    def test_journal_stream_of_another_file_is_ignored(self):
        with tempfile.TemporaryFile("w+") as stream:
            self._log_all({"JOURNAL_STREAM": "1:2"}, stream)
            stream.seek(0)
            self.assertTrue(stream.read().startswith("INFO: "))

    def test_reconfiguring_does_not_duplicate_output(self):
        stream = io.StringIO()
        configure_logging({}, stream)
        configure_logging({}, stream)
        self.logger.warning("once")
        self.assertEqual(stream.getvalue(), "WARNING: once\n")


if __name__ == "__main__":
    unittest.main()
