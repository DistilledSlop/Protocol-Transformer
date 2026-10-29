import json
import shutil
import tempfile
from pathlib import Path
import unittest

import torch

from protocol_ai.data import SPECIALS, Vocab
from protocol_ai.generate import Generator
from protocol_ai.model import Config, RowModel
from train import load_initial_weights


class PortableCheckpointTest(unittest.TestCase):
    def test_relocation_and_checked_weight_initialization(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'old'
            dataset = root / 'datasets' / 'example'
            run = root / 'runs' / 'example'
            dataset.mkdir(parents=True)
            run.mkdir(parents=True)
            tokens = list(SPECIALS) + ['a', 'b']
            (dataset / 'vocab.json').write_text(json.dumps({'tokens': tokens}))
            cfg = Config(vocab_size=len(tokens), ctx_len=16, n_layer=1, n_head=1, n_embd=8)
            source = RowModel(cfg)
            torch.save({'cfg': cfg.__dict__, 'model': source.state_dict(),
                        'vocab': '../../datasets/example/vocab.json',
                        'vocab_relative_to_checkpoint': True}, run / 'best.pt')
            moved = Path(tmp) / 'moved'
            shutil.move(root, moved)
            checkpoint = moved / 'runs/example/best.pt'
            vocab_path = moved / 'datasets/example/vocab.json'
            generator = Generator.load(checkpoint, 'cpu')
            self.assertEqual(generator.vocab.tokens, tokens)
            target = RowModel(cfg)
            load_initial_weights(target, cfg, Vocab.from_tokens(tokens), checkpoint, vocab_path)
            for name, tensor in source.state_dict().items():
                self.assertTrue(torch.equal(tensor, target.state_dict()[name]))
            with self.assertRaisesRegex(ValueError, 'vocabulary'):
                load_initial_weights(target, cfg, Vocab.from_tokens(tokens[:-2] + ['b', 'a']), checkpoint, vocab_path)
            incompatible = Config(vocab_size=len(tokens), ctx_len=17, n_layer=1, n_head=1, n_embd=8)
            with self.assertRaisesRegex(ValueError, 'configuration'):
                load_initial_weights(target, incompatible, Vocab.from_tokens(tokens), checkpoint, vocab_path)
