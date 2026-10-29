#!/usr/bin/env bash
# Train from the portable training root, or set DATASET to an exported dataset.
set -euo pipefail
cd "$(dirname "$0")"
root=$PWD
TRAINING_ROOT=$(python3 -c 'import os, sys; print(os.path.abspath(sys.argv[1]))' "${TRAINING_ROOT:-$root/../vibrato-training}")

if [[ -z ${DATASET:-} ]]; then
    # Published Conductor exports include an admission snapshot and a ready split.
    DATASET=$(python3 - "$TRAINING_ROOT/datasets" <<'PYDATA'
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

if [[ ${GPUS:-1} != 1 ]]; then
    echo "train.sh supports one GPU; set GPUS=1 or unset GPUS" >&2
    exit 1
fi
# Cap CPU compute threads; users can override either variable.
if [[ -z ${OMP_NUM_THREADS:-} ]]; then
    available_cpus=$(nproc)
    if (( available_cpus > 32 )); then available_cpus=32; fi
    OMP_NUM_THREADS=$available_cpus
fi
export OMP_NUM_THREADS
export MKL_NUM_THREADS=${MKL_NUM_THREADS:-$OMP_NUM_THREADS}
if [[ -n ${TRAIN_EXTRA:-} ]]; then
    extra=$TRAIN_EXTRA
elif [[ ${DEVICE:-} == cpu ]]; then
    extra=cpu
else
    extra=cuda
fi
if [[ $extra != cuda && $extra != cpu ]]; then
    echo "TRAIN_EXTRA must be cuda or cpu" >&2
    exit 1
fi
if [[ $extra == cpu ]]; then
    device=${DEVICE:-cpu}
else
    device=${DEVICE:-cuda:0}
fi
cd train
exec uv run --locked --extra "$extra" python train.py --dataset "$DATASET" --val "${val[@]}" --steps "${STEPS:-3000}" --eval-every "${EVAL_EVERY:-1000}" --name "${NAME:-night}" --run-root "$TRAINING_ROOT/runs" --device "$device" "$@"
