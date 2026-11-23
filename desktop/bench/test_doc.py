import json
import unittest
from pathlib import Path

import table

BENCH = Path(__file__).resolve().parent
DOC = BENCH.parents[1] / "docs" / "desktop-performance.md"
RESULTS = BENCH / "results" / "linux-dev-pc.json"


class DocumentMatchesMeasurement(unittest.TestCase):
    def setUp(self):
        self.document = json.loads(RESULTS.read_text())
        self.text = DOC.read_text()

    def test_every_table_in_the_document_is_generated_from_the_committed_json(self):
        for generated in table.tables(self.document):
            self.assertIn(generated, self.text)

    def test_every_run_received_exactly_what_was_sent(self):
        self.assertEqual(self.document["countProblems"], [])
        for result in self.document["comm"] + self.document["chart"]:
            self.assertEqual(result["sent"], result["received"], result["name"])
            self.assertEqual(result["sent"], result["perSecond"] * self.document["seconds"], result["name"])


if __name__ == "__main__":
    unittest.main()
