import unittest
from unittest.mock import MagicMock, patch

from agent.telemetry import TELEMETRY_VERSION, collect_telemetry


class TelemetryCollectorTests(unittest.TestCase):
    @patch("agent.telemetry.psutil")
    @patch("agent.telemetry.time")
    def test_collect_telemetry_schema_and_types(self, mock_time, mock_psutil):
        mock_time.time.return_value = 1_700_000_100
        mock_psutil.cpu_percent.return_value = 12.5
        mock_psutil.virtual_memory.return_value = MagicMock(
            total=16_000_000_000,
            used=8_000_000_000,
        )
        mock_psutil.disk_usage.return_value = MagicMock(
            total=500_000_000_000,
            used=200_000_000_000,
        )
        mock_psutil.boot_time.return_value = 1_700_000_000

        data = collect_telemetry()

        self.assertEqual(data["version"], TELEMETRY_VERSION)
        self.assertIsInstance(data["collected_at"], str)
        self.assertEqual(data["cpu_percent"], 12.5)
        self.assertEqual(data["memory_total_bytes"], 16_000_000_000)
        self.assertEqual(data["memory_used_bytes"], 8_000_000_000)
        self.assertEqual(data["memory_percent"], 50.0)
        self.assertEqual(data["disk_total_bytes"], 500_000_000_000)
        self.assertEqual(data["disk_used_bytes"], 200_000_000_000)
        self.assertEqual(data["disk_percent"], 40.0)
        self.assertEqual(data["uptime_seconds"], 100)
        self.assertIsInstance(data["uptime_seconds"], int)

    @patch("agent.telemetry.psutil")
    def test_cpu_collection(self, mock_psutil):
        mock_psutil.cpu_percent.return_value = 7.25
        mock_psutil.virtual_memory.return_value = MagicMock(total=1000, used=100)
        mock_psutil.disk_usage.return_value = MagicMock(total=1000, used=100)
        mock_psutil.boot_time.return_value = 0

        data = collect_telemetry()
        mock_psutil.cpu_percent.assert_called_once()
        self.assertEqual(data["cpu_percent"], 7.25)

    @patch("agent.telemetry.psutil")
    def test_memory_collection(self, mock_psutil):
        mock_psutil.cpu_percent.return_value = 1.0
        mock_psutil.virtual_memory.return_value = MagicMock(
            total=4096,
            used=1024,
        )
        mock_psutil.disk_usage.return_value = MagicMock(total=1000, used=10)
        mock_psutil.boot_time.return_value = 0

        data = collect_telemetry()
        self.assertEqual(data["memory_total_bytes"], 4096)
        self.assertEqual(data["memory_used_bytes"], 1024)
        self.assertEqual(data["memory_percent"], 25.0)

    @patch("agent.telemetry.psutil")
    def test_disk_collection(self, mock_psutil):
        mock_psutil.cpu_percent.return_value = 1.0
        mock_psutil.virtual_memory.return_value = MagicMock(total=1000, used=10)
        mock_psutil.disk_usage.return_value = MagicMock(
            total=10_000,
            used=2_500,
        )
        mock_psutil.boot_time.return_value = 0

        data = collect_telemetry(root_path="/")
        mock_psutil.disk_usage.assert_called_with("/")
        self.assertEqual(data["disk_total_bytes"], 10_000)
        self.assertEqual(data["disk_used_bytes"], 2_500)
        self.assertEqual(data["disk_percent"], 25.0)

    @patch("agent.telemetry.psutil")
    @patch("agent.telemetry.time")
    def test_uptime_collection(self, mock_time, mock_psutil):
        mock_time.time.return_value = 5000
        mock_psutil.cpu_percent.return_value = 0.0
        mock_psutil.virtual_memory.return_value = MagicMock(total=1000, used=1)
        mock_psutil.disk_usage.return_value = MagicMock(total=1000, used=1)
        mock_psutil.boot_time.return_value = 2000

        data = collect_telemetry()
        self.assertEqual(data["uptime_seconds"], 3000)
