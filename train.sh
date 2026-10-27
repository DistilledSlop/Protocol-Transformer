# Train the model on the dataset that preprocess.sh made, and report. The terrain input is used automatically because the
# dataset has terrain patches. Overrides:  STEPS=1500 NAME=try bash train.sh
#
# --eval-every 100 prints the validation loss often enough to see where it stops improving (the best point is kept).
# 3000 steps: four times the data (the turned copies) takes about 13 passes where 1500 steps was 51 over the unturned data.
STEPS=${STEPS:-3000}
NAME=${NAME:-night}

cd "$(dirname "$0")"
if [ ! -f dataset/val.txt ]; then
    echo "no dataset yet: run  bash preprocess.sh  first" >&2
    exit 1
fi
cd train && uv run python train.py --dataset ../dataset --val $(cat ../dataset/val.txt) --steps "$STEPS" --eval-every 100 --name "$NAME"
