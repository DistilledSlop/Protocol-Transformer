#!/usr/bin/env bash
# Run the model as a Minecraft server, a JSONL service, or a capture replay.
set -euo pipefail
cd "$(dirname "$0")"
repo=$PWD
training_root=${TRAINING_ROOT:-$repo/../vibrato-training}
[[ $training_root == /* ]] || training_root=$repo/$training_root
for var in CKPT DATASET WORLD; do
    value=${!var:-}
    if [[ -n $value && $value != /* ]]; then
        printf -v "$var" '%s/%s' "$repo" "$value"
    fi
done
mode=${MODE:-minecraft}
if [[ ${1:-} == --help || ${1:-} == -h ]]; then
    cat <<'HELP'
Usage: ./inference.sh [minecraft|serve|replay] [options]
Default: minecraft. serve reads/writes JSON lines; replay requires --session NAME.
TRAINING_ROOT, CKPT, DATASET, WORLD, TRAIN_EXTRA and DEVICE select assets and device.
Minecraft options: HOST, PORT, ALSO, TIME, ENGINE_TIME, MODEL_ARGS.
HELP
    exit 0
fi
if [[ ${1:-} == minecraft || ${1:-} == serve || ${1:-} == replay ]]; then
    mode=$1
    shift
fi
if [[ $mode != minecraft && $mode != serve && $mode != replay ]]; then
    echo "Usage: $0 [minecraft|serve|replay] [options]" >&2
    exit 2
fi
if [[ $mode == minecraft ]]; then
    if ! command -v node >/dev/null 2>&1; then
        echo 'Minecraft mode requires Node.js 22 or newer; install Node.js and run (cd proxy && npm ci)' >&2
        exit 1
    fi
    if [[ ! -f proxy/node_modules/minecraft-protocol/package.json || ! -f proxy/node_modules/minecraft-data/package.json ]]; then
        echo 'Minecraft dependencies are missing; install Node.js 22 or newer and run (cd proxy && npm ci)' >&2
        exit 1
    fi
fi
extra=${TRAIN_EXTRA:-}
if [[ -z $extra ]]; then
    if [[ ${DEVICE:-} == cpu ]]; then extra=cpu; else extra=cuda; fi
fi
if [[ $extra != cuda && $extra != cpu ]]; then
    echo 'TRAIN_EXTRA must be cuda or cpu' >&2
    exit 1
fi
if [[ $extra == cpu ]]; then device=${DEVICE:-cpu}; else device=${DEVICE:-cuda:0}; fi
export TRAIN_EXTRA=$extra
resolver=(uv run --locked --extra "$extra" python assets.py --root "$training_root")
[[ -z ${CKPT:-} ]] || resolver+=(--ckpt "$CKPT")
[[ -z ${DATASET:-} ]] || resolver+=(--dataset "$DATASET")
assets=$(cd train && "${resolver[@]}")
mapfile -t paths <<< "$assets"
ckpt=${paths[0]}
dataset=${paths[1]}
if [[ $mode == minecraft ]]; then
    if [[ -z ${WORLD:-} ]]; then
        WORLD=$(python3 - "$training_root/worlds" <<'PYWORLD'
import sys
from pathlib import Path
worlds = Path(sys.argv[1])
pairs = [p for p in worlds.glob('*.bin') if p.is_file() and p.with_suffix('.jsonl').is_file()]
if pairs:
    print(max(pairs, key=lambda p: (p.stat().st_mtime_ns, str(p))).with_suffix(''))
PYWORLD
)
    fi
    if [[ -z ${WORLD:-} || ! -f ${WORLD}.bin || ! -f ${WORLD}.jsonl ]]; then
        echo 'Minecraft mode needs WORLD set to the base path of a captured .bin/.jsonl pair, or a pair under TRAINING_ROOT/worlds' >&2
        exit 1
    fi
    args=("$WORLD" --ckpt "$ckpt" --dataset "$dataset" --port "${PORT:-25569}" --host "${HOST:-127.0.0.1}" --also "${ALSO:-blocks,slots,text,events}" --time "${TIME:-cycle}")
    [[ -z ${ENGINE_TIME:-} ]] || args+=(--engine-time)
    args+=(--model-args "--device $device ${MODEL_ARGS:---temperature 0.8}")
    exec node engine/model_server.js "${args[@]}" "$@"
fi
cd train
exec uv run --locked --extra "$extra" python infer.py "$mode" --ckpt "$ckpt" --dataset "$dataset" --device "$device" "$@"
