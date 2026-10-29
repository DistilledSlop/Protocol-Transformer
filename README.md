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
   The best checkpoint is written to `../vibrato-training/runs/first/best.pt`.

Without `DATASET`, the launcher chooses the newest published `training-*` dataset in `../vibrato-training/datasets/` by manifest modification time, checking its source index, ready split, validation list, and required files, falling back to `dataset/`. Set `TRAINING_ROOT` to relocate the common `datasets/` and `runs/` directories, or `DATASET` to select another exported dataset. Its `val.txt` must list one held-out session name per line. The split
is a point-in-time snapshot; check the Conductor admission receipts are still
current before using it.

The launcher defaults to 32 CPU threads per worker, capped at the CPUs available to the
process divided by the number of workers (and at least one per worker); set `OMP_NUM_THREADS` and `MKL_NUM_THREADS` to change this. On the
shared training host, 32 threads were within 4% of 48-thread throughput in a
short benchmark with fewer PyTorch compute threads; these are not dedicated cores. Set `DEVICE=cpu` to
force CPU or leave it unset for automatic GPU detection. To install and use the
locked CUDA build, run `(cd train && uv sync --locked --extra cuda)` and launch
with `TRAIN_EXTRA=cuda DEVICE=cuda:0 bash train.sh`; use this extra on each CUDA launch.
Additional `train.py` options may be passed after `bash train.sh`.

For multiple GPUs on one machine, set the number of GPUs to use:

```bash
GPUS=4 DEVICE=cuda NAME=multi-gpu bash train.sh --batch 16
```

`GPUS` defaults to 1; values greater than 1 launch one distributed worker per GPU and automatically select the CUDA extra. `TRAIN_EXTRA`, if specified, must be `cuda`, and `DEVICE` must select CUDA or be unset. Any CUDA device index supplied in `DEVICE` is ignored for distributed runs; each worker uses its local GPU. Use `CUDA_VISIBLE_DEVICES` to choose which GPUs are visible (for example, `CUDA_VISIBLE_DEVICES=2,3 GPUS=2`). The `--batch` value is per GPU, so this example has a global batch of 64. Each worker loads the dataset into host memory, so available RAM can limit scaling. Dataset selection and the shared run directory use the same `DATASET` and `TRAINING_ROOT` settings as a single-GPU run.

## Move training to a CUDA machine

Clone the Protocol-Transformer source on the target and copy the `vibrato-training` directory as its sibling. Exclude generated `.venv/`, `node_modules/`, and dataset `.cache/` directories from the transfer; these are not required for training. Copy only the run checkpoints you want to keep. The latter contains `datasets/<dataset>/` (including its manifest, vocabulary, validation list, tick and terrain files, and source index) and `runs/<run>/` for optional checkpoints. Raw Conductor captures and Conductor itself are not needed to train an already exported dataset. Preserve the directory layout; set `TRAINING_ROOT` if it is elsewhere. The source index records provenance from the original host and is not a runtime path.

Install uv and Python 3.12 on the target, then from the repository run:

```bash
(cd train && uv sync --locked --extra cuda)
TRAIN_EXTRA=cuda DEVICE=cuda:0 NAME=gpu-run bash train.sh
```

The target needs an NVIDIA driver compatible with the CUDA 12.8 PyTorch build. CUDA execution must be checked on that GPU machine; it was not hardware-tested on the CPU host. This starts a fresh run. To initialize from an existing checkpoint, add `--init-from /path/to/best.pt --init-vocab /path/to/the-original-dataset/vocab.json` and select the same architecture and context options used for that checkpoint. The vocabulary and configuration must match. This copies model weights only: optimizer, learning-rate schedule, random state, and step count start over. Existing CPU checkpoints may record an old absolute vocabulary path; supplying `--init-vocab` explicitly works after transfer. New checkpoints record a path relative to the checkpoint; inference can also use an explicit dataset or vocabulary.

## Serve a model

Inference needs the generated dataset, a checkpoint, and a recording containing
the world's join packets:

```bash
WORLD=proxy/data/session_Player_1234567890 \
CKPT=../vibrato-training/runs/first/best.pt \
DATASET=../vibrato-training/datasets/YOUR_DATASET \
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
