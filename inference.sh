#!/usr/bin/env bash
# Serve the trained model as a Minecraft 1.21.1 server. Join localhost:$PORT as $WORLD's player (offline mode).
# The world around the first position comes from a captured session; everything that moves is the model's.
# Override with env vars, e.g.  PORT=25570 CKPT=train/runs/first/best.pt bash inference.sh
cd "$(dirname "$0")"

WORLD=${WORLD:-proxy/data/session_EmeraldIngot64_1793056989898}
CKPT=${CKPT:-train/runs/night/best.pt}
DATASET=${DATASET:-dataset}
PORT=${PORT:-25569}
HOST=${HOST:-127.0.0.1}                  # 0.0.0.0 to let other machines join
ALSO=${ALSO:-blocks,slots,text,events}   # what the model owns besides the entity scene; add globals for health/xp/weather
TIME=${TIME:-cycle}                       # cycle: the day runs. keep: as recorded (a frozen night if your server has the day cycle off). noon, midnight: locked

# ENGINE_TIME=1: the engine answers /time set|add|query itself instead of the model (until the model has learned to)
exec node engine/model_server.js "$WORLD" --ckpt "$CKPT" --dataset "$DATASET" --port "$PORT" --host "$HOST" --also "$ALSO" --time "$TIME" ${ENGINE_TIME:+--engine-time} --model-args "${MODEL_ARGS:---temperature 0.8}"
