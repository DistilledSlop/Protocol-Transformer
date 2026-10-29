#!/usr/bin/env bash
# Train on a verified Conductor dataset, or set DATASET to an exported dataset.
set -euo pipefail
cd "$(dirname "$0")"
root=$PWD

if [[ -z ${DATASET:-} ]]; then
    # Published Conductor exports include an admission snapshot and a ready split.
    DATASET=$(python3 - "$root/../Vibrato-Conductor/.state" <<'PYDATA'
import glob, json, os, sys
candidates = []
for dataset in glob.glob(os.path.join(sys.argv[1], 'training-*')):
    try:
        manifest_path = os.path.join(dataset, 'manifest.json')
        with open(manifest_path) as f:
            manifest = json.load(f)
        with open(os.path.join(dataset, 'source-index.json')) as f:
            index = json.load(f)
        with open(os.path.join(dataset, 'val.txt')) as f:
            val = f.read().splitlines()
        names = {session['name'] for session in manifest['sessions']}
        if (index['split']['ready'] is True and index['trainBases'] and val
                and val == index['validationSessionNames'] and set(val) <= names
                and os.path.isfile(os.path.join(dataset, 'vocab.json'))):
            candidates.append((os.stat(manifest_path).st_mtime_ns, dataset))
    except (OSError, ValueError, KeyError, TypeError):
        continue
if candidates:
    print(max(candidates)[1])
PYDATA
    )
    DATASET=${DATASET:-"$root/dataset"}
fi
if [[ ! -f "$DATASET/val.txt" || ! -f "$DATASET/manifest.json" || ! -f "$DATASET/vocab.json" ]]; then
    echo "Dataset must contain manifest.json, vocab.json and val.txt: $DATASET" >&2
    exit 1
fi
DATASET=$(cd "$DATASET" && pwd -P)
mapfile -t val < "$DATASET/val.txt"
if (( ${#val[@]} == 0 )); then
    echo "Validation list is empty: $DATASET/val.txt" >&2
    exit 1
fi
# Every line is one exact session name, including names with shell metacharacters.
for name in "${val[@]}"; do
    if [[ -z "$name" || "$name" == *$'\r'* ]]; then
        echo "Invalid empty or CR-containing validation name in $DATASET/val.txt" >&2
        exit 1
    fi
done

# Limit CPU contention on shared hosts. Users can override either variable.
export OMP_NUM_THREADS=${OMP_NUM_THREADS:-4}
export MKL_NUM_THREADS=${MKL_NUM_THREADS:-$OMP_NUM_THREADS}
device=()
if [[ -n ${DEVICE:-} ]]; then device=(--device "$DEVICE"); fi
cd train
exec uv run --locked --extra "${TRAIN_EXTRA:-cpu}" python train.py --dataset "$DATASET" --val "${val[@]}" --steps "${STEPS:-3000}" --eval-every "${EVAL_EVERY:-100}" --name "${NAME:-night}" "${device[@]}" "$@"
