#!/usr/bin/env bash
# Record play for training data. Run this, then join localhost:$PROXY_PORT (not the server's own port) with Minecraft 1.21.1.
# The proxy passes everything through to your local server and saves each session to proxy/data/session_<name>_<time>.{bin,jsonl}.
# The big parsed log is off (LOG_PARSED=0): training only needs the raw capture, and it is several times the size.
# Override with env vars, e.g.  TARGET_PORT=25580 PROXY_PORT=25566 bash record.sh
cd "$(dirname "$0")/proxy"

export PROXY_PORT=${PROXY_PORT:-25566}
export TARGET_HOST=${TARGET_HOST:-127.0.0.1}
export TARGET_PORT=${TARGET_PORT:-25565}
export LOG_PARSED=${LOG_PARSED:-0}

if ! (exec 3<>"/dev/tcp/$TARGET_HOST/$TARGET_PORT") 2>/dev/null; then
    echo "nothing is listening on $TARGET_HOST:$TARGET_PORT: start your server first" >&2
    exit 1
fi
if (exec 3<>"/dev/tcp/127.0.0.1/$PROXY_PORT") 2>/dev/null; then
    echo "port $PROXY_PORT is already in use (a recorder may already be running: just join localhost:$PROXY_PORT)" >&2
    exit 1
fi
echo "free disk: $(df -h --output=avail . | tail -1 | tr -d ' ')"
exec node index.js
