# Turn the captures in proxy/data into the training set (dataset/): vocabulary, token rows and terrain patches.
# Run this after recording new sessions or after changing anything in reader/; then run train.sh.
# Sessions are tokenized in parallel and kept in dataset/.cache, so only new or changed captures (or a changed reader) cost time.
#
# Every capture is training data except the held-out ones. Hold out two (a long one and a short one):
# validation on a single session is noisy, and the best checkpoint is picked on it.
VAL="EmeraldIngot64_1793056989898 EmeraldIngot64_1793060710488"
OUT=${OUT:-dataset}

cd "$(dirname "$0")"
P=proxy/data/session_
TRAIN=""
for f in ${P}*.bin; do
    s=${f%.bin}
    case " $VAL " in *" ${s#$P} "*) ;; *) TRAIN="$TRAIN $s" ;; esac
done
VALPATHS=""
for v in $VAL; do VALPATHS="$VALPATHS,${P}$v"; done

# Augmentation: every training session is also built with the world turned 90, 180 and 270 degrees (--augment 3, named
# <session>@r1..@r3), so movement, hits and placements are seen facing four ways. The held-out sessions are used as recorded.
# The vocabulary comes from the training sessions and all their turned copies. The terrain patches
# (<session>.terrain.u8, about 2 KB per 4 ticks) are written alongside.
node reader/dataset/dataset.js build --out "$OUT" --augment 3 --val "${VALPATHS#,}" $TRAIN || exit 1

# which sessions train.sh validates on
for v in $VAL; do echo "session_$v"; done > "$OUT/val.txt"
echo "dataset ready in $OUT: $(echo $TRAIN | wc -w) training sessions (x4 turned), held out: $VAL"
