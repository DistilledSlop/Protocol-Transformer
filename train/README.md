# train

Next-row model for Protocol AI. Python 3.12 is managed with uv. Use `uv sync --locked --extra cpu` for CPU PyTorch, or `uv sync --locked --extra cuda` for CUDA 12.8 (including RTX 50-series). The extras are mutually exclusive; use the same extra in each `uv run` invocation. The root `train.sh` defaults to CPU packages and selects a published dataset under the common training root, with `DATASET` and `TRAIN_EXTRA` overrides described in the root README. The data also comes from the JS reader:

    # 1. freeze a vocabulary on the training captures and export every capture (no GPU, a few MB)
    node reader/dataset/dataset.js vocab  --out dataset  proxy/data/session_A ...
    node reader/dataset/dataset.js export --vocab dataset/vocab.json --out dataset  proxy/data/session_A ... proxy/data/session_HELDOUT

    # 2. the design doc's infrastructure check: 100 ticks must be memorised to ~0 loss
    uv run --extra cpu python train.py --dataset ../dataset --overfit --layers 2 --embd 128 --steps 600

    # 3. train on every session but the held-out one, report per-field accuracy and the baselines
    uv run --extra cpu python train.py --dataset ../dataset --val session_HELDOUT --steps 1500 --name first

    uv run --extra cpu python -m unittest discover -s tests          # data module tests (numpy only)

For large validation sets, `--eval-windows-per-session N` bounds evaluation cost by sampling up to N evenly spaced windows from each held-out session (default 96). The final report reuses the last evaluation.

Stream format: for every tick, `TICK`, the client's input rows (`IN`), engine-derived rows (`ENG`), then the target rows
(`OUT`), then `END`. Loss counts only the target rows and the `END`, so the model learns to answer each tick's input; an idle tick
is `TICK END`. Windows start at tick boundaries. Hold out whole captures for validation (the frozen vocabulary turns their unseen
tokens into `<unk>`, as it would for new content).

What the report means: "tick decision" is the first target token of each tick (OUT or END: does anything happen?) against the
always-idle baseline; the per-field table is teacher-forced accuracy against always predicting the most common token of the field.
Grammar (field tags, row structure) is learned quickly; dynamics (when and how entities move) need far more data than a dozen
minutes of captures.
