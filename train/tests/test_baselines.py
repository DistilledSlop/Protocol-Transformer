import math
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from train import baselines


def stream(tokens, mask):
    return SimpleNamespace(tokens=np.array(tokens), loss_mask=np.array(mask))


class BaselinesTest(unittest.TestCase):
    def test_tie_uses_first_seen_and_unseen_category_has_no_hits(self):
        # Token 1 wins its tie with token 0, despite token 0 being numerically smaller.
        train = {"train": stream([1, 0, 2], [1, 1, 0])}
        val = {"val": stream([1, 0, 2], [1, 1, 1])}
        vocab = SimpleNamespace(tokens=["a", "b", "c"])
        cats = np.array(["known", "known", "unseen"])
        with patch("train.data.describe", return_value={"fraction_ticks_with_out": 0.25}):
            result = baselines(train, val, vocab, cats)
        self.assertEqual(result["majority_acc"], {"known": 0.5, "unseen": 0.0})
        self.assertAlmostEqual(result["unigram_nll"], -(2 * math.log(1.5 / 3.5) + math.log(0.5 / 3.5)) / 3)
        self.assertEqual(result["idle_tick_fraction"], 0.75)
