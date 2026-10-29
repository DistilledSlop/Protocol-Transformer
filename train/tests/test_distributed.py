"""An isolated torchrun smoke test: no exported sessions or GPUs required."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def worker(root):
    import torch.distributed as dist
    import train
    from protocol_ai import data

    # Compare the DDP gradient with the concatenated batch, including a rank
    # with no target tokens. This exercises the token weighting in train_main.
    import copy
    from protocol_ai.model import Config, RowModel
    from torch.nn.parallel import DistributedDataParallel
    dist.init_process_group("gloo")
    rank = dist.get_rank()
    for masks in ([[1, 1, 1, 1], [1, 0, 0, 0]], [[1, 1, 1, 1], [0, 0, 0, 0]]):
        torch.manual_seed(23)
        model = RowModel(Config(vocab_size=9, ctx_len=4, n_layer=1, n_head=2, n_embd=8, dropout=0))
        reference = copy.deepcopy(model)
        ddp = DistributedDataParallel(model)
        x = torch.tensor([[0, 1, 2, 3], [3, 4, 5, 6]])
        y = torch.tensor([[1, 2, 3, 4], [4, 5, 6, 7]])
        m = torch.tensor(masks, dtype=torch.float32)
        _, expected = reference(x, y, m)
        expected.backward()
        _, loss = ddp(x[rank:rank+1], y[rank:rank+1], m[rank:rank+1])
        train.distributed_token_loss(loss, m[rank:rank+1], 2).backward()
        for actual, wanted in zip(model.parameters(), reference.parameters()):
            torch.testing.assert_close(actual.grad, wanted.grad, atol=1e-6, rtol=1e-5)
    dist.destroy_process_group()

    vocab = data.Vocab.from_tokens(list(data.SPECIALS))
    train.data.load_vocab = lambda _: vocab
    ticks = 32
    stream = data.Stream(
        tokens=np.tile(np.array([vocab.tick, vocab.out, vocab.end], dtype=np.int32), ticks),
        loss_mask=np.tile(np.array([0, 1, 1], dtype=np.uint8), ticks),
        tick_start=np.arange(ticks, dtype=np.int64) * 3,
        tick_of=np.arange(ticks, dtype=np.int32),
    )
    train.load_streams = lambda ds, names, v: {name: stream for name in names}
    original_step = torch.optim.AdamW.step
    def checked_step(self, *args, **kwargs):
        for p in self.param_groups[0]['params']:
            if p.grad is not None:
                copies = [torch.empty_like(p.grad) for _ in range(dist.get_world_size())]
                dist.all_gather(copies, p.grad)
                assert all(torch.allclose(copies[0], x) for x in copies[1:])
        return original_step(self, *args, **kwargs)
    torch.optim.AdamW.step = checked_step
    sys.argv = ['train.py', '--dataset', root, '--run-root', root, '--name', 'out',
                '--train', 'train', '--val', 'val', '--steps', '2', '--eval-every', '1',
                '--batch', '2', '--ctx', '6', '--layers', '1', '--heads', '2',
                '--embd', '8', '--dropout', '0', '--device', 'cpu']
    assert train.main() == 0


class DistributedTest(unittest.TestCase):
    def test_disjoint_reproducible_samples(self):
        import train
        sets = [list(range(4)), list(range(5))]
        original = train.collate
        train.collate = lambda items, device: [(sets.index(ws), i) for ws, i in items]
        try:
            batches = [train.sample_distributed_batch(sets, 3, np.random.default_rng(42), 'cpu', r, 2) for r in range(2)]
            self.assertEqual(len(set(batches[0] + batches[1])), 6)
            self.assertEqual(batches[0], train.sample_distributed_batch(sets, 3, np.random.default_rng(42), 'cpu', 0, 2))
            with self.assertRaisesRegex(ValueError, 'global batch'):
                train.sample_distributed_batch(sets, 5, np.random.default_rng(0), 'cpu', 0, 2)
        finally:
            train.collate = original

    def test_two_process_training(self):
        with tempfile.TemporaryDirectory() as tmp:
            from protocol_ai.data import SPECIALS
            Path(tmp, 'vocab.json').write_text(json.dumps({'tokens': list(SPECIALS)}))
            Path(tmp, 'manifest.json').write_text(json.dumps({'sessions': [{'name': 'train'}, {'name': 'val'}]}))
            env = dict(os.environ, DDP_TEST_ROOT=tmp, OMP_NUM_THREADS='1')
            result = subprocess.run([sys.executable, '-m', 'torch.distributed.run', '--standalone',
                                     '--nproc-per-node=2', __file__], env=env,
                                    text=True, capture_output=True, timeout=90)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(result.stdout.count('best val NLL'), 1)
            self.assertIn('[rank 0/2] device cpu; loading dataset', result.stdout)
            self.assertIn('[rank 1/2] device cpu; loading dataset', result.stdout)
            self.assertIn('step     1 train loss', result.stdout)
            for rank in (0, 1):
                self.assertIn(f'[rank {rank}/2] step 1: backward returned', result.stdout)
                self.assertIn(f'[rank {rank}/2] step 1: batch x=cpu', result.stdout)
            self.assertIn('evaluating at step 1 across 2 workers', result.stdout)
            out = Path(tmp, 'out')
            checkpoint = torch.load(out / 'best.pt', map_location='cpu', weights_only=False)
            self.assertTrue(checkpoint['model'])
            self.assertFalse(any(k.startswith('module.') for k in checkpoint['model']))
            metrics = json.loads((out / 'metrics.json').read_text())
            self.assertEqual(metrics['world_size'], 2)
            self.assertEqual(metrics['global_batch'], 4)
            self.assertEqual(metrics['args']['batch'], 2)
            self.assertIn('training workers 2; batch per worker 2; global batch 4', result.stdout)


if __name__ == '__main__':
    if 'DDP_TEST_ROOT' in os.environ:
        worker(os.environ['DDP_TEST_ROOT'])
    else:
        unittest.main()
