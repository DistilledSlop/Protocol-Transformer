# Protocol Transformer

An experimental Minecraft Java 1.21.1 (protocol 767) pipeline for recording
network traffic, turning it into typed token rows, training a next-row model,
and compiling generated rows back into client packets.

The project includes a recording proxy, packet reader and writer, terrain-aware
dataset builder, PyTorch training code, and live/replay model servers. It is
research code: the current model is experimental and does not yet outperform
an always-idle baseline. See the component documentation for known limitations.

## Setup

Use Node.js 22 or newer, npm, Bash, and uv. Training requires Python 3.12;
`train/.python-version` and `train/uv.lock` pin the Python environment. The
default launcher installs CPU-only PyTorch; a locked CUDA 12.8 build is available
for NVIDIA GPUs.

From the repository root:

```bash
(cd proxy && npm ci)
(cd train && uv sync --locked --extra cpu)
```

The reader and engine share the dependencies installed in `proxy/node_modules`.
Captures, generated datasets, model weights, and training runs are excluded
from Git and are not supplied with the source.

## Record, preprocess, and train

1. Start a Minecraft 1.21.1 server in offline mode on `127.0.0.1:25565`.
2. Run `bash record.sh`, then join `127.0.0.1:25566` with a matching client.
   Stop the recorder cleanly after playing; sessions are saved under `proxy/data/`.
3. Record several sessions and choose at least one whole session for validation.
   Set `VAL` to the filename stems without the `session_` prefix or extension:

   ```bash
   VAL="Player_1234567890 Player_1234567891" bash preprocess.sh
   ```

   Replace the example names with your recorded sessions. Other sessions become
   training data. The script builds `dataset/`, including the vocabulary, terrain
   patches, rotated training examples, and validation list. Its defaults refer
   to the original author's local captures, so set `VAL` for a fresh dataset.
4. Train with `DATASET="$PWD/dataset" STEPS=3000 NAME=first bash train.sh`.
   The best checkpoint is written to `train/runs/first/best.pt`.

Without `DATASET`, the launcher chooses the newest published Conductor `training-*` dataset by manifest modification
time, checking its source index, ready split, validation list, and required files, falling back to `dataset/`. Set `DATASET` to select another exported
dataset. Its `val.txt` must list one held-out session name per line. The split
is a point-in-time snapshot; check the Conductor admission receipts are still
current before using it.

The launcher limits CPU compute to four threads by default on shared hosts; set
`OMP_NUM_THREADS` and `MKL_NUM_THREADS` to change this. Set `DEVICE=cpu` to
force CPU or leave it unset for automatic GPU detection. To install and use the
locked CUDA build, run `(cd train && uv sync --locked --extra cuda)` and launch
with `TRAIN_EXTRA=cuda bash train.sh`; use this extra on each CUDA launch.
Additional `train.py` options may be passed after `bash train.sh`.

## Serve a model

Inference needs the generated dataset, a checkpoint, and a recording containing
the world's join packets:

```bash
WORLD=proxy/data/session_Player_1234567890 \
CKPT=train/runs/first/best.pt \
bash inference.sh
```

Replace `WORLD` with an actual capture base path (without `.bin`). Join
`127.0.0.1:25569` in offline mode using that recording's player name. The world
is limited to captured chunks. See [reader/README.md](reader/README.md) for
replay modes, model controls, and packet reconstruction limitations.

## Checks

```bash
(cd proxy && npm test)
node --test reader/test/*.test.js reader/test/families/*.test.js
(cd train && uv run --extra cpu python -m unittest discover -s tests)
```

## Components

| Directory | Purpose |
| --- | --- |
| [proxy/](proxy/README.md) | Record raw packet frames and session indexes |
| [reader/](reader/README.md) | Decode packets, track state, build datasets, and write packets |
| [train/](train/README.md) | Train and run the next-row model |
| `engine/` | Live transformation, recording replay, and model serving |
| `bots/` | Recording helpers |

Keep local captures, player data, credentials, and model artifacts out of source
commits. Store or distribute weights separately when needed.
