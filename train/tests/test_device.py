"""Check device errors before the dataset is loaded."""
import sys
import unittest
from unittest.mock import patch

import train


class DeviceTest(unittest.TestCase):
    def test_unavailable_cuda_fails_before_loading_data(self):
        with patch.object(sys, "argv", ["train.py", "--dataset", "/missing"]), \
             patch("torch.cuda.is_available", return_value=False), \
             patch.object(train.data, "load_vocab") as load_vocab, \
             self.assertRaises(SystemExit):
            train.train_main()
        load_vocab.assert_not_called()

    def test_invalid_cuda_index_fails_before_loading_data(self):
        with patch.object(sys, "argv", ["train.py", "--device", "cuda:1"]), \
             patch("torch.cuda.is_available", return_value=True), \
             patch("torch.cuda.device_count", return_value=1), \
             patch.object(train.data, "load_vocab") as load_vocab, \
             self.assertRaises(SystemExit):
            train.train_main()
        load_vocab.assert_not_called()
