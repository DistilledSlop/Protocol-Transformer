# train

Next-row model for Protocol AI. Python 3.12 is managed with uv. Use `uv sync --locked --extra cpu` for CPU PyTorch, or `uv sync --locked --extra cuda` for CUDA 12.8 (including RTX 50-series). The extras are mutually exclusive; use the same extra in each `uv run` invocation. The root `train.sh` defaults to CUDA packages and selects a published dataset under the common training root, with `DATASET` and `TRAIN_EXTRA` overrides described in the root README. The data also comes from the JS reader:

    # 1. freeze a vocabulary on the training captures and export every capture (no GPU, a few MB)
    node reader/dataset/dataset.js vocab  --out dataset  proxy/data/session_A ...
    node reader/dataset/dataset.js export --vocab dataset/vocab.json --out dataset  proxy/data/session_A ... proxy/data/session_HELDOUT

    # 2. the design doc's infrastructure check: 100 ticks must be memorised to ~0 loss
    uv run --extra cpu python train.py --dataset ../dataset --overfit --layers 2 --embd 128 --steps 600

    # 3. train on every session but the held-out one, report per-field accuracy and the baselines
    uv run --extra cpu python train.py --dataset ../dataset --val session_HELDOUT --steps 1500 --name first

    uv run --extra cpu python -m unittest discover -s tests          # data module tests (numpy only)

From the repository root, `bash train.sh` trains on the first visible CUDA GPU. Set `CUDA_VISIBLE_DEVICES` to select a GPU, or use `TRAIN_EXTRA=cpu DEVICE=cpu bash train.sh` for CPU. See the root README for dataset and run paths and launcher options.

Training logs the first step and every 10 steps by default; use `--log-every N` to change the interval. Each distributed worker reports its process ID, device, startup phases, and first-step milestones. Milestones report when the host call returns; CUDA work can still be running asynchronously. For a stall after the first step, add `--debug-distributed` to report milestones on every step. Dataset loading happens on each worker and baseline calculation happens on rank 0 before distributed training starts. With terrain enabled, DDP may warn that `find_unused_parameters=True` found no unused parameters in a forward pass. This is a performance warning: terrain can be used conditionally on other batches, so the flag remains enabled. An actual reduction error is a separate issue.

For large validation sets, `--eval-windows-per-session N` bounds evaluation cost by sampling up to N evenly spaced windows from each held-out session (default 96). Distributed workers share validation windows and aggregate the metrics; each worker reports its local progress. The final report reuses the last evaluation.

Block changes are rare (about 0.5% of ticks) and the model has to copy their coordinates from the client's input, so uniform windows teach it too slowly. By default a quarter of each batch (`--focus-fraction 0.25`) is windows placed around server block-change rows (`OUT BLOCK ...`), with the input that caused the change in view, and those rows count five times in the loss (`--block-loss-weight 5`). Set `--focus-fraction 0 --block-loss-weight 1` for the old uniform behaviour. Each evaluation also scores up to `--eval-block-windows` held-out block-change windows: the share of block rows whose every token is the model's top choice ("whole row exact"), their mean joint probability, and token accuracy. The checkpoint with the best joint probability is saved as `best-block.pt` next to `best.pt`, which is still chosen by overall validation NLL (the one `inference.sh` loads); pass `CKPT` to use `best-block.pt`. These scores are over all block changes, not just dig-finishes.

Stream format: for every tick, `TICK`, the client's input rows (`IN`), engine-derived rows (`ENG`), then the target rows
(`OUT`), then `END`. Loss counts only the target rows and the `END`, so the model learns to answer each tick's input; an idle tick
is `TICK END`. Windows start at tick boundaries. Hold out whole captures for validation (the frozen vocabulary turns their unseen
tokens into `<unk>`, as it would for new content).

What the report means: "tick decision" is the first target token of each tick (OUT or END: does anything happen?) against the
always-idle baseline; the per-field table is teacher-forced accuracy against always predicting the most common token of the field.
Grammar (field tags, row structure) is learned quickly; dynamics (when and how entities move) need far more data than a dozen
minutes of captures.
