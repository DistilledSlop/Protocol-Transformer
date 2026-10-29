import json
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import unittest


class InferenceLauncherTest(unittest.TestCase):
    def test_modes_pass_arguments_and_discover_complete_world(self):
        repo = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_repo = repo
            repo = root / 'repo'
            repo.mkdir()
            shutil.copy(source_repo / 'inference.sh', repo / 'inference.sh')
            (repo / 'train').mkdir()
            for package in ('minecraft-protocol', 'minecraft-data'):
                package_dir = repo / 'proxy' / 'node_modules' / package
                package_dir.mkdir(parents=True)
                (package_dir / 'package.json').touch()
            worlds = root / 'worlds'
            worlds.mkdir()
            for name in ['older', 'new world']:
                (worlds / f'{name}.bin').touch()
                (worlds / f'{name}.jsonl').touch()
            os.utime(worlds / 'older.bin', (1, 1))
            (worlds / 'incomplete.bin').touch()
            uv = root / 'uv'
            uv.write_text('#!/usr/bin/env python3\nimport json, os, sys\n'
                          'if "assets.py" in sys.argv: print(os.environ["CKPT"] + "\\n" + os.environ["DATASET"])\n'
                          'else: open(os.environ["ARGS_FILE"], "w").write(json.dumps(sys.argv[1:]))\n')
            uv.chmod(0o755)
            node = root / 'node'
            node.write_text('#!/usr/bin/env python3\nimport json, os, sys\n'
                            'open(os.environ["ARGS_FILE"], "w").write(json.dumps(sys.argv[1:]))\n')
            node.chmod(0o755)
            env = dict(os.environ, PATH=f'{root}:{os.environ["PATH"]}', TRAINING_ROOT=str(root),
                       CKPT=str(root / 'best file.pt'), DATASET=str(root / 'data set'),
                       ARGS_FILE=str(root / 'args.json'), DEVICE='cpu', TRAIN_EXTRA='cpu')
            env.pop('WORLD', None)
            subprocess.run([str(repo / 'inference.sh'), 'replay', '--session', 'name with spaces'], env=env, check=True)
            args = json.loads((root / 'args.json').read_text())
            self.assertEqual(args[args.index('--dataset') + 1], env['DATASET'])
            self.assertEqual(args[args.index('--device') + 1], 'cpu')
            self.assertEqual(args[-2:], ['--session', 'name with spaces'])
            subprocess.run([str(repo / 'inference.sh'), 'minecraft', '--join-speed', '2'], env=env, check=True)
            args = json.loads((root / 'args.json').read_text())
            self.assertEqual(args[1], str(worlds / 'new world'))
            self.assertEqual(args[-2:], ['--join-speed', '2'])
            self.assertIn('--device cpu', args[args.index('--model-args') + 1])
            relative_env = dict(env, CKPT='relative/best.pt', DATASET='relative/data',
                                TRAINING_ROOT='relative/root', WORLD='relative/world')
            subprocess.run([str(repo / 'inference.sh'), 'serve'], env=relative_env, check=True)
            args = json.loads((root / 'args.json').read_text())
            self.assertEqual(args[args.index('--ckpt') + 1], str(repo / 'relative/best.pt'))
            self.assertEqual(args[args.index('--dataset') + 1], str(repo / 'relative/data'))
            bad = subprocess.run([str(repo / 'inference.sh')], env=dict(env, WORLD=str(root / 'missing')), capture_output=True, text=True)
            self.assertNotEqual(bad.returncode, 0)
            self.assertIn('captured .bin/.jsonl pair', bad.stderr)
