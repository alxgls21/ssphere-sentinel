import json
import unittest

from agent.acknowledgement import parse_acknowledgement

A, B, C, D = (f"00000000-0000-0000-0000-00000000000{i}" for i in range(1, 5))


def body(**fields):
    return json.dumps({"status": "ok", **fields})


class ResultsProtocolTests(unittest.TestCase):
    def test_created_and_duplicate_are_stored(self):
        ack = parse_acknowledgement(
            body(
                network="accepted",
                network_results=[
                    {"measurement_id": A, "result": "created"},
                    {"measurement_id": B, "result": "duplicate"},
                ],
            ),
            [A, B],
        )
        self.assertFalse(ack.is_batch_failure)
        self.assertEqual(ack.stored, {A, B})
        self.assertEqual(ack.unresolved, set())

    def test_partial_with_permanent_and_retryable_rejections(self):
        ack = parse_acknowledgement(
            body(
                network="partial",
                network_results=[
                    {"measurement_id": A, "result": "created"},
                    {"measurement_id": B, "result": "rejected", "reason": "target is disabled", "retryable": False},
                    {"measurement_id": C, "result": "rejected", "reason": "measurement could not be stored", "retryable": True},
                ],
            ),
            [A, B, C, D],
        )
        self.assertEqual(ack.stored, {A})
        self.assertEqual(ack.permanent, {B: "target is disabled"})
        self.assertEqual(ack.retryable, {C: "measurement could not be stored"})
        self.assertEqual(ack.unresolved, {D})

    def test_rejection_without_valid_retryable_flag_is_kept(self):
        ack = parse_acknowledgement(
            body(
                network="rejected",
                network_results=[{"measurement_id": A, "result": "rejected", "reason": "x"}],
            ),
            [A],
        )
        self.assertEqual(ack.retryable, {A: "x"})
        self.assertEqual(ack.permanent, {})

    def test_unknown_ids_and_bad_entries_are_ignored(self):
        ack = parse_acknowledgement(
            body(
                network="accepted",
                network_results=[
                    {"measurement_id": "someone-else", "result": "created"},
                    "garbage",
                    {"measurement_id": A, "result": "mystery"},
                    {"measurement_id": B},
                ],
            ),
            [A, B],
        )
        self.assertEqual(ack.stored, set())
        self.assertEqual(ack.unresolved, {A, B})

    def test_conflicting_entries_are_unresolved(self):
        ack = parse_acknowledgement(
            body(
                network="partial",
                network_results=[
                    {"measurement_id": A, "result": "created"},
                    {"measurement_id": A, "result": "rejected", "reason": "x", "retryable": False},
                ],
            ),
            [A],
        )
        self.assertEqual(ack.stored, set())
        self.assertEqual(ack.permanent, {})
        self.assertEqual(ack.unresolved, {A})

    def test_results_not_a_list_is_batch_failure(self):
        ack = parse_acknowledgement(body(network="accepted", network_results={}), [A])
        self.assertTrue(ack.is_batch_failure)


class AmbiguousResponseTests(unittest.TestCase):
    def test_malformed_responses_never_acknowledge(self):
        cases = {
            "not json": "<html>",
            "empty": "",
            "array": "[1]",
            "no network key": body(),
            "unknown status": body(network="maybe"),
            "section rejected": body(network="rejected", network_detail="unsupported network version"),
        }
        for label, raw in cases.items():
            with self.subTest(label):
                ack = parse_acknowledgement(raw, [A, B])
                self.assertTrue(ack.is_batch_failure)
                self.assertEqual(ack.stored, set())
                self.assertEqual(ack.permanent, {})

    def test_nothing_sent_means_nothing_to_acknowledge(self):
        ack = parse_acknowledgement("garbage", [])
        self.assertFalse(ack.is_batch_failure)


class CountsWithoutResultsTests(unittest.TestCase):
    def test_counts_alone_never_acknowledge_anything(self):
        # Every server sends network_results; counts without them are not trusted.
        for extra in (
            dict(network="accepted", network_created=1, network_duplicates=1),
            dict(network="partial", network_accepted=2, network_rejections=[{"measurement_id": C, "reason": "x"}]),
        ):
            with self.subTest(extra=extra):
                ack = parse_acknowledgement(body(**extra), [A, B, C])
                self.assertTrue(ack.is_batch_failure)
                self.assertEqual(ack.stored, set())


if __name__ == "__main__":
    unittest.main()
