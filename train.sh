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

gpus=${GPUS:-1}
if [[ ! $gpus =~ ^[1-9][0-9]*$ ]]; then
    echo "GPUS must be a positive integer: $gpus" >&2
    exit 1
fi
# Divide the available CPUs between workers, capped at 32 threads per worker.
# Users can override either variable for their workload and host.
if [[ -z ${OMP_NUM_THREADS:-} ]]; then
    available_cpus=$(nproc)
    # Avoid arithmetic overflow for an absurdly large GPUS value.
    if (( ${#gpus} > 6 )) || (( gpus > available_cpus )); then
        available_cpus=1
    else
        available_cpus=$((available_cpus / gpus))
    fi
    if (( available_cpus > 32 )); then available_cpus=32; fi
    OMP_NUM_THREADS=$available_cpus
fi
export OMP_NUM_THREADS
export MKL_NUM_THREADS=${MKL_NUM_THREADS:-$OMP_NUM_THREADS}
device=()
if [[ -n ${DEVICE:-} ]]; then device=(--device "$DEVICE"); fi
launcher=(python)
extra=${TRAIN_EXTRA:-cpu}
if [[ $gpus != 1 ]]; then
    if [[ -n ${TRAIN_EXTRA:-} && $TRAIN_EXTRA != cuda ]]; then
        echo "GPUS greater than 1 requires TRAIN_EXTRA=cuda" >&2
        exit 1
    fi
    if [[ -n ${DEVICE:-} && ! $DEVICE =~ ^cuda(:[0-9]+)?$ ]]; then
        echo "GPUS greater than 1 requires a CUDA DEVICE or an unset DEVICE" >&2
        exit 1
    fi
    extra=cuda
    launcher=(torchrun --standalone --nnodes=1 "--nproc-per-node=$gpus")
fi
cd train
exec uv run --locked --extra "$extra" "${launcher[@]}" train.py --dataset "$DATASET" --val "${val[@]}" --steps "${STEPS:-3000}" --eval-every "${EVAL_EVERY:-100}" --name "${NAME:-night}" --run-root "$TRAINING_ROOT/runs" "${device[@]}" "$@"
