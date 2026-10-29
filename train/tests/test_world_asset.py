import json
import tempfile
import unittest
from pathlib import Path

from world_asset import select_world


class WorldAssetTest(unittest.TestCase):
    def test_training_only_deduplicates_and_prefers_portable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dataset = root / 'dataset'
            dataset.mkdir()
            originals = root / 'originals'
            originals.mkdir()
            captures = dataset / 'captures'
            captures.mkdir()
            worlds = root / 'worlds'
            worlds.mkdir()
            for base in (originals / 'first', originals / 'second', originals / 'heldout', worlds / 'first', captures / 'first', worlds / 'heldout', worlds / 'unlisted'):
                Path(str(base) + '.bin').touch()
                Path(str(base) + '.jsonl').touch()
            (dataset / 'source-index.json').write_text(json.dumps({
                'trainBases': [str(originals / 'first'), str(originals / 'first'), str(originals / 'second'), str(originals / 'missing')],
                'validationBases': [str(originals / 'heldout')]}))
            seen = []
            result = select_world(root, dataset, chooser=lambda candidates: seen.extend(candidates) or candidates[-1])
            self.assertEqual(seen, [captures / 'first', originals / 'second'])
            self.assertEqual(result, originals / 'second')
            Path(str(originals / 'second') + '.jsonl').unlink()
            self.assertEqual(select_world(root, dataset), captures / 'first')
            Path(str(captures / 'first') + '.bin').unlink()
            self.assertEqual(select_world(root, dataset), worlds / 'first')
            Path(str(worlds / 'first') + '.bin').unlink()
            Path(str(originals / 'first') + '.bin').unlink()
            with self.assertRaisesRegex(ValueError, 'Copy training captures'):
                select_world(root, dataset)

    def test_missing_provenance_and_ambiguous_portable_basename(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaisesRegex(ValueError, 'provenance'):
                select_world(root, root)
            (root / 'source-index.json').write_text(json.dumps({'trainBases': ['/a/same', '/b/same']}))
            (root / 'worlds').mkdir()
            (root / 'worlds/same.bin').touch()
            (root / 'worlds/same.jsonl').touch()
            with self.assertRaisesRegex(ValueError, 'No complete training capture'):
                select_world(root, root)
