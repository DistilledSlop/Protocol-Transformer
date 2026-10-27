# train

Next-row model for Protocol AI. Python, managed with uv (`uv sync` builds `.venv`; torch comes from the CUDA 12.8 index so the
RTX 50-series works). The data comes from the JS reader:

    # 1. freeze a vocabulary on the training captures and export every capture (no GPU, a few MB)
    node reader/dataset/dataset.js vocab  --out dataset  proxy/data/session_A ...
    node reader/dataset/dataset.js export --vocab dataset/vocab.json --out dataset  proxy/data/session_A ... proxy/data/session_HELDOUT

    # 2. the design doc's infrastructure check: 100 ticks must be memorised to ~0 loss
    uv run python train.py --dataset ../dataset --overfit --layers 2 --embd 128 --steps 600

    # 3. train on every session but the held-out one, report per-field accuracy and the baselines
    uv run python train.py --dataset ../dataset --val session_HELDOUT --steps 1500 --name first

    python3 -m unittest discover -s tests          # data module tests (numpy only)

Stream format: for every tick, `TICK`, the client's input rows (`IN`), engine-derived rows (`ENG`), then the target rows
(`OUT`), then `END`. Loss counts only the target rows and the `END`, so the model learns to answer each tick's input; an idle tick
is `TICK END`. Windows start at tick boundaries. Hold out whole captures for validation (the frozen vocabulary turns their unseen
tokens into `<unk>`, as it would for new content).

What the report means: "tick decision" is the first target token of each tick (OUT or END: does anything happen?) against the
always-idle baseline; the per-field table is teacher-forced accuracy against always predicting the most common token of the field.
Grammar (field tags, row structure) is learned quickly; dynamics (when and how entities move) need far more data than a dozen
minutes of captures.
