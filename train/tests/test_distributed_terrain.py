"""Exercise conditional terrain use across ranks without a dataset or GPUs."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import unittest

import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def worker():
    import torch.distributed as dist
    from torch.nn.parallel import DistributedDataParallel
    from protocol_ai.model import Config, RowModel

    dist.init_process_group("gloo")
    try:
        rank = dist.get_rank()
        torch.manual_seed(7)
        model = RowModel(Config(vocab_size=9, ctx_len=4, n_layer=1, n_head=2,
                                n_embd=8, dropout=0, terrain=True))
        assert model.head.weight is model.tok.weight
        ddp = DistributedDataParallel(model, find_unused_parameters=True)
        optimizer = torch.optim.SGD(ddp.parameters(), lr=0.01)
        x = torch.tensor([[0, 1, 2, 3]])
        y = torch.tensor([[1, 2, 3, 4]])
        mask = torch.ones_like(x, dtype=torch.float32)
        # Alternate the rank that uses the encoder, then omit it on both ranks.
        for terrain_rank in (1, 0, None, 1, 0):
            terrain = None
            if rank == terrain_rank:
                patches = torch.full((1, 13, 13, 13), rank + 1, dtype=torch.uint8)
                terrain = (patches, torch.tensor([0]), torch.tensor([1]), torch.tensor([0]))
            optimizer.zero_grad(set_to_none=True)
            logits, loss = ddp(x, y, mask, terrain=terrain)
            assert logits.shape == (1, 4, 9)
            loss.backward()
            for name, parameter in model.named_parameters():
                # All ranks must agree whether a gradient exists, and on its value.
                present = torch.tensor(int(parameter.grad is not None))
                flags = [torch.empty_like(present) for _ in range(2)]
                dist.all_gather(flags, present)
                assert flags[0].item() == flags[1].item(), name
                if parameter.grad is not None:
                    copies = [torch.empty_like(parameter.grad) for _ in range(2)]
                    dist.all_gather(copies, parameter.grad)
                    torch.testing.assert_close(copies[0], copies[1], msg=name)
                if name.startswith("terrain_enc."):
                    assert bool(present.item()) == (terrain_rank is not None), name
            before = model.tok.weight.detach().clone()
            optimizer.step()
            assert not torch.equal(before, model.tok.weight), "optimizer did not update"
    finally:
        dist.destroy_process_group()


class DistributedTerrainTest(unittest.TestCase):
    def test_conditional_terrain_across_ranks(self):
        env = dict(os.environ, DDP_TERRAIN_WORKER="1", OMP_NUM_THREADS="1")
        process = subprocess.Popen(
            [sys.executable, "-m", "torch.distributed.run", "--standalone",
             "--nproc-per-node=2", __file__],
            env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True,
        )
        try:
            stdout, stderr = process.communicate(timeout=90)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
            self.fail("distributed workers timed out\n" + stdout + stderr)
        self.assertEqual(process.returncode, 0, stdout + stderr)


if __name__ == "__main__":
    if "DDP_TERRAIN_WORKER" in os.environ:
        worker()
    else:
        unittest.main()
