"""Two-process evaluation parity without datasets or GPUs."""
import os
from pathlib import Path
import subprocess
import sys
import unittest

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class Windows:
    def __init__(self, count):
        self.count = count

    def __len__(self):
        return self.count

    def __getitem__(self, i):
        return (np.array([i % 3, 1, 2]), np.array([1, i % 3, 2]),
                np.array([1, i % 2, 1]))

    def terrain_of(self, i):
        return None


class Model(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.table = torch.nn.Parameter(torch.tensor([[0.2, 0.3, -0.1], [0.4, -0.3, 0.5], [0.1, 0.7, 0.2]]))

    def forward(self, x, terrain=None):
        return self.table[x], None


def assert_nested(actual, expected):
    assert actual.keys() == expected.keys()
    for key in actual:
        if isinstance(actual[key], dict):
            assert_nested(actual[key], expected[key])
        else:
            assert abs(actual[key] - expected[key]) < 1e-6, (key, actual[key], expected[key])


def worker():
    import torch.distributed as dist
    from torch.nn.parallel import DistributedDataParallel
    from train import evaluate

    dist.init_process_group('gloo')
    rank = dist.get_rank()
    model = Model()
    ddp = DistributedDataParallel(model)
    cats = np.array(['a', 'b', 'b'])
    original = model.table.detach().clone()
    for count in (5, 1, 0):
        for training in (True, False):
            model.train(training)
            sets = [Windows(count)]
            expected = evaluate(model, sets, cats, 'cpu', 2, bs=2)
            assert model.training == training
            seen = []
            actual = evaluate(ddp, sets, cats, 'cpu', 2, bs=2, distributed=True,
                              rank=rank, world_size=2, progress=lambda done, total: seen.append((done, total)))
            assert_nested(actual, expected)
            assert model.training == training
            assert torch.equal(model.table, original)
            local_count = len(range(rank, count, 2))
            assert (seen[-1] == (local_count, local_count)) if local_count else not seen
    dist.destroy_process_group()


class DistributedEvaluateTest(unittest.TestCase):
    def test_parity_and_empty_shards(self):
        env = dict(os.environ, EVALUATE_WORKER='1', OMP_NUM_THREADS='1')
        result = subprocess.run([sys.executable, '-m', 'torch.distributed.run', '--standalone',
                                 '--nproc-per-node=2', __file__], env=env, text=True,
                                capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    if 'EVALUATE_WORKER' in os.environ:
        worker()
    else:
        unittest.main()
