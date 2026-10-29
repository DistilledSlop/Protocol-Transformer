import json
import tempfile
import unittest
from pathlib import Path

import torch
from assets import fingerprint, resolve


def dataset(path, tokens):
    path.mkdir(parents=True)
    (path / 'manifest.json').write_text('{"sessions": []}')
    (path / 'vocab.json').write_text(json.dumps({'tokens': tokens}))
    return path


class InferenceAssetsTest(unittest.TestCase):
    def test_relocated_checkpoint_and_vocabulary_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ds = dataset(root / 'datasets' / 'original', ['a', 'b'])
            run = root / 'runs' / 'one'
            run.mkdir(parents=True)
            torch.save({'cfg': {'vocab_size': 2}, 'vocab': '../../datasets/original/vocab.json',
                        'vocab_relative_to_checkpoint': True,
                        'vocab_sha256': fingerprint(ds / 'vocab.json')}, run / 'best.pt')
            (run / 'metrics.json').write_text('{}')
            ckpt, selected, _ = resolve(root)
            self.assertEqual((ckpt, selected), (run / 'best.pt', ds))
            equivalent = dataset(root / 'equivalent', ['a', 'b'])
            (equivalent / 'vocab.json').write_text(json.dumps({'tokens': ['a', 'b'], 'sessions': ['other']}, indent=2))
            self.assertEqual(resolve(root, ckpt, equivalent)[1], equivalent)
            other = dataset(root / 'other', ['b', 'a'])
            with self.assertRaisesRegex(ValueError, 'does not match'):
                resolve(root, ckpt, other)

    def test_legacy_checkpoint_uses_portable_run_provenance(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ds = dataset(root / 'datasets' / 'original', ['a'])
            run = root / 'runs' / 'one'
            run.mkdir(parents=True)
            torch.save({'cfg': {'vocab_size': 1}, 'vocab': '/missing/original/vocab.json'}, run / 'best.pt')
            (run / 'metrics.json').write_text(json.dumps({'args': {'dataset': '/old/original'}}))
            self.assertEqual(resolve(root)[1], ds)
            (run / 'metrics.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'set DATASET'):
                resolve(root)
