"""Choose a raw world capture belonging to the selected training dataset."""
import json
import secrets
from collections import Counter
from pathlib import Path


def select_world(root, dataset, chooser=secrets.choice):
    index_path = Path(dataset) / 'source-index.json'
    try:
        index = json.loads(index_path.read_text())
        bases = index['trainBases']
        if not isinstance(bases, list) or not all(isinstance(base, str) and base for base in bases):
            raise ValueError('trainBases must be a list of paths')
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise ValueError(f'Cannot read training capture provenance from {index_path}: {exc}') from exc

    # A basename must identify one source before a portable copy can be matched.
    sources = list(dict.fromkeys(Path(base) for base in bases))
    names = Counter(base.name for base in sources)
    candidates = []
    for source in sources:
        portable = [Path(dataset) / 'captures' / source.name, Path(root) / 'worlds' / source.name]
        def complete(base):
            return Path(str(base) + '.bin').is_file() and Path(str(base) + '.jsonl').is_file()
        choices = portable if names[source.name] == 1 else []
        choices = [*choices, source]
        candidate = next((base for base in choices if complete(base)), None)
        if candidate is not None:
            candidates.append(candidate)
    if not candidates:
        raise ValueError(f'No complete training capture pairs are available. Copy training captures listed in {index_path} into {Path(dataset) / "captures"} or {Path(root) / "worlds"}, including both .bin and .jsonl files, or set WORLD explicitly')
    return chooser(candidates)


if __name__ == '__main__':
    import sys
    try:
        print(select_world(sys.argv[1], sys.argv[2]))
    except ValueError as exc:
        print(f'inference: {exc}', file=sys.stderr)
        sys.exit(1)
