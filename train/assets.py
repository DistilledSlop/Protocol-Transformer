"""Resolve inference assets and check that the checkpoint uses the selected vocabulary."""
import hashlib
import json
from pathlib import Path

import torch


def fingerprint(path):
    # Hash the token mapping, independent of JSON formatting.
    return fingerprint_tokens(json.loads(Path(path).read_text())['tokens'])


def fingerprint_tokens(tokens):
    return hashlib.sha256(json.dumps(tokens, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def resolve(root, checkpoint=None, dataset=None):
    root = Path(root).resolve()
    if checkpoint:
        ckpt = Path(checkpoint).resolve()
    else:
        candidates = [p for p in (root / 'runs').glob('*/best.pt') if (p.parent / 'metrics.json').is_file()]
        if not candidates:
            raise ValueError(f'No completed run with best.pt and metrics.json under {root / "runs"}; set CKPT')
        ckpt = max(candidates, key=lambda p: (p.stat().st_mtime_ns, str(p)))
    ck = torch.load(ckpt, map_location='cpu', weights_only=False)
    if not isinstance(ck, dict) or not isinstance(ck.get('cfg'), dict) or not isinstance(ck['cfg'].get('vocab_size'), int) or ck['cfg']['vocab_size'] <= 0:
        raise ValueError(f'Checkpoint has no valid cfg.vocab_size: {ckpt}')
    recorded = Path(ck['vocab']) if ck.get('vocab') else None
    if recorded is not None and ck.get('vocab_relative_to_checkpoint'):
        recorded = ckpt.parent / recorded
    expected = ck.get('vocab_sha256')
    if not expected and recorded and recorded.is_file():
        expected = fingerprint(recorded)
    if dataset:
        ds = Path(dataset).resolve()
    elif recorded and recorded.is_file():
        ds = recorded.resolve().parent
    else:
        # Older runs recorded the original absolute dataset path in metrics.
        try:
            metrics = json.loads((ckpt.parent / 'metrics.json').read_text())
            name = Path(metrics['args']['dataset']).name
            ds = root / 'datasets' / name
        except (OSError, ValueError, KeyError, TypeError):
            raise ValueError('Cannot identify the checkpoint dataset; set DATASET explicitly') from None
        if not (ds / 'vocab.json').is_file():
            raise ValueError(f'Cannot find checkpoint dataset at {ds}; set DATASET explicitly')
    if not (ds / 'manifest.json').is_file() or not (ds / 'vocab.json').is_file():
        raise ValueError(f'Dataset must contain manifest.json and vocab.json: {ds}')
    tokens = json.loads((ds / 'vocab.json').read_text())['tokens']
    if not isinstance(tokens, list) or len(tokens) != ck['cfg']['vocab_size']:
        raise ValueError(f'Dataset vocabulary size does not match checkpoint: {ds}')
    if expected and fingerprint(ds / 'vocab.json') != expected:
        raise ValueError(f'Dataset vocabulary does not match checkpoint: {ds}')
    return ckpt, ds, ck


if __name__ == '__main__':
    import argparse
    import sys
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', required=True)
    ap.add_argument('--ckpt')
    ap.add_argument('--dataset')
    a = ap.parse_args()
    try:
        checkpoint, dataset, _ = resolve(a.root, a.ckpt, a.dataset)
        print(checkpoint)
        print(dataset)
    except (ValueError, OSError, KeyError) as exc:
        print(f'inference: {exc}', file=sys.stderr)
        sys.exit(1)
