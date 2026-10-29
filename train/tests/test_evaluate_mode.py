import unittest

import numpy as np
import torch

from train import evaluate


class EvaluateModeTest(unittest.TestCase):
    def test_restores_previous_model_mode(self):
        model = torch.nn.Dropout()
        model.train()
        evaluate(model, [], np.array([], dtype=object), "cpu", 0)
        self.assertTrue(model.training)
