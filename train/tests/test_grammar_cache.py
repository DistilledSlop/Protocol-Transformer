import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from protocol_ai import data
from protocol_ai.generate import Grammar
from protocol_ai.grammar_cache import learn_cached


class GrammarCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.vocab = data.Vocab.from_tokens(list(data.SPECIALS) + ["MOVE", "x=1", "CHAT", "text=hello"])
        self.sessions = [{"name": name, "firstTick": 0, "lastTick": 1} for name in ("a", "b", "val")]
        (self.path / "manifest.json").write_text(json.dumps({"sessions": self.sessions}))
        for name, row in (("a", [1, 9, 10]), ("b", [1, 11, 12]), ("val", [1, 11, 10])):
            (self.path / f"{name}.ticks.jsonl").write_text(json.dumps({"t": 0, "r": [row]}) + "\n")

    def learn(self, excluded=("val",), jobs=1, vocab=None):
        return learn_cached(self.path, vocab or self.vocab, excluded, jobs)

    def caches(self):
        return list((self.path / "grammar-cache").glob("*.json"))

    def test_parallel_parity_and_cache_hit(self):
        expected = set()
        for session in self.sessions[:2]:
            name = session["name"]
            stream = data.build_stream(data.load_ticks(self.path / f"{name}.ticks.jsonl"), 0, 1, self.vocab)
            expected.update(Grammar.learn(self.vocab, {name: stream}))
        self.assertEqual(self.learn(jobs=2), expected)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.assertEqual(self.learn(), expected)
        self.assertIn("Loaded grammar cache", stderr.getvalue())
        with self.assertRaises(ValueError):
            self.learn(jobs=0)

    def test_invalidation_and_corruption(self):
        expected = self.learn()
        cache = self.caches()[0]
        for bad in ("[]", "null", "{broken", '{"pairs": []}'):
            cache.write_text(bad)
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                self.assertEqual(self.learn(), expected)
            self.assertIn("Learning grammar", stderr.getvalue())
        self.learn(excluded=())
        self.assertEqual(len(self.caches()), 2)
        changed_vocab = data.Vocab.from_tokens(self.vocab.tokens + ["new_token"])
        self.learn(vocab=changed_vocab)
        self.assertEqual(len(self.caches()), 3)
        (self.path / "a.ticks.jsonl").write_text(json.dumps({"t": 1, "r": [[1, 9]]}) + "\n")
        self.learn()
        self.assertEqual(len(self.caches()), 4)

    def test_worker_failure_does_not_cache(self):
        (self.path / "a.ticks.jsonl").write_text("bad json\n")
        with self.assertRaises(ValueError):
            self.learn(jobs=2)
        self.assertEqual(self.caches(), [])


if __name__ == "__main__":
    unittest.main()
