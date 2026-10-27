# Recording proxy

Minecraft 1.21.1 offline-mode recording proxy. Install with `npm ci`, start with `LOG_PARSED=0 node index.js`, and connect the client to the proxy port. The server must also run in offline mode. The default listener is loopback; set `PROXY_HOST` explicitly to expose it on another interface.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXY_HOST` | `127.0.0.1` | Listener address |
| `PROXY_PORT` | `25566` | Listener port |
| `TARGET_HOST` | `127.0.0.1` | Dedicated server address |
| `TARGET_PORT` | `25565` | Dedicated server port |
| `CAPTURE_DIR` | `proxy/data` | Capture output directory; parent directories are created |
| `CAPTURE_RUN_ID` | unset | Run identity recorded in session headers |
| `LOG_PARSED` | enabled | Set `0` to retain raw data and indexes without parsed play logs |
| `RECORDER_MAX_QUEUED_BYTES` | `8388608` | Hard limit on queued recorder stream bytes |
| `RECORDER_MAX_BYTES` | `1073741824` | Raw byte limit per session |
| `PROXY_MAX_QUEUE_BYTES` | `8388608` | Limit on configuration packets queued between legs |

Raw `.bin` payloads and `.jsonl` indexes retain the reader's existing format. A per-session `.status.json` starts incomplete and becomes complete only after successful stream closure and fsync. SIGINT and SIGTERM close both network legs and drain recorders, with a ten-second shutdown deadline. A write error or queue/capture limit stops the proxy with a nonzero exit and leaves the affected capture incomplete. Unique names avoid accidental session overwrites.

A complete marker establishes file flushing, not task success or dataset eligibility. Login is terminated on each leg; handshake and status are not recorded, and login capture is partial. Configuration and play traffic are tapped from complete uncompressed frames before the packet parser, then recorded before forwarding. Parser failures cannot silently remove those frames; parser callbacks cannot mutate the retained or forwarded copy. Compression changes and bundle delimiters retain their wire order. The optional parsed log can still omit packets the library cannot decode. The existing parser/forwarder repair limitations still apply; see the reader documentation.

Run focused recorder tests with `npm test` (Node 22+). They cover exact byte/index offsets, idempotent close, byte limits, and file-open failures.
