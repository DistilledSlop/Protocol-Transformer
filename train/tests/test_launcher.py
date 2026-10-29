"""Exercise launcher argument handling without starting a training job."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class LauncherTest(unittest.TestCase):
    def test_dataset_and_validation_names_are_passed_as_distinct_arguments(self):
        root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            dataset = tmp / "dataset with spaces"
            dataset.mkdir()
            for filename in ("manifest.json", "vocab.json"):
                (dataset / filename).write_text("{}")
            (dataset / "val.txt").write_text("one name\nother*name\n")
            stub = tmp / "uv"
            stub.write_text('#!/usr/bin/env python3\nimport json, os, sys\n'
                            'open(os.environ["ARGS_FILE"], "w").write(json.dumps(sys.argv[1:]))\n')
            stub.chmod(0o755)
            env = dict(os.environ, PATH=f"{tmp}:{os.environ['PATH']}", DATASET=str(dataset),
                       ARGS_FILE=str(tmp / "args.json"), DEVICE="cpu", TRAIN_EXTRA="cpu")
            subprocess.run(["bash", str(root / "train.sh"), "--batch", "2"], env=env, check=True)
            args = json.loads((tmp / "args.json").read_text())
            self.assertEqual(args[args.index("--dataset") + 1], str(dataset))
            self.assertEqual(args[args.index("--val") + 1:args.index("--steps")], ["one name", "other*name"])
            self.assertEqual(args[args.index("--device") + 1], "cpu")
            self.assertEqual(args[-2:], ["--batch", "2"])

    def test_empty_validation_list_is_rejected(self):
        root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as tmp:
            dataset = Path(tmp)
            for name in ("manifest.json", "vocab.json", "val.txt"):
                (dataset / name).touch()
            result = subprocess.run(["bash", str(root / "train.sh")],
                                    env=dict(os.environ, DATASET=str(dataset)), capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Validation list is empty", result.stderr)
