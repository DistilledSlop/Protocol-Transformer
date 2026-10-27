const mc = require('minecraft-protocol');
const fs = require('fs');
const path = require('path');
const { createRecorder } = require('./recorder');
const sanitize = require('./sanitize');
const states = mc.states;

// the proxy listens on PROXY_PORT and forwards to the server at TARGET_HOST:TARGET_PORT (your local server by default)
const PROXY_PORT = +process.env.PROXY_PORT || 25566;
const TARGET_HOST = process.env.TARGET_HOST || '127.0.0.1';
const TARGET_PORT = +process.env.TARGET_PORT || 25565;
const VERSION = '1.21.1';

// LOG_PARSED=0           skip the parsed play log (<base>.parsed.jsonl); raw bytes are always recorded
// SHOW_PARSE_ERRORS=1    show PartialReadError output instead of hiding it (to find packets the parser fails on)
const LOG_PARSED = process.env.LOG_PARSED !== '0';
const SHOW_PARSE_ERRORS = process.env.SHOW_PARSE_ERRORS === '1';
// Packet names whose parsed JSON is huge and already covered by the raw bytes. Adjust to the names in your logs.
const SKIP_PARSED = new Set(['map_chunk', 'update_light']);

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
}

// Flush all open sessions on Ctrl+C so the tail of a capture is not lost.
const openRecorders = new Set();
process.on('SIGINT', () => {
    Promise.all([...openRecorders].map((r) => r.close())).then(() => process.exit(0));
});

const server = mc.createServer({
    'online-mode': false,
    port: PROXY_PORT,
    version: VERSION,
    keepAlive: false,
    hideErrors: !SHOW_PARSE_ERRORS // Stops NMP from spamming PartialReadError in console
});

console.log(`Offline Proxy (${VERSION}) listening on port ${PROXY_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`);

server.on('login', (incomingClient) => {
    console.log(`[Proxy] ${incomingClient.username} logging in...`);

    const base = path.join(DATA_DIR, `session_${incomingClient.username}_${Date.now()}`);
    const rec = createRecorder(base, { logParsed: LOG_PARSED, skipParsed: SKIP_PARSED });
    openRecorders.add(rec);
    rec.header({
        version: VERSION,
        target: `${TARGET_HOST}:${TARGET_PORT}`,
        username: incomingClient.username,
    });
    console.log(`[Recorder] Saving capture to: ${base}.{bin,jsonl${LOG_PARSED ? ',parsed.jsonl' : ''}}`);

    const repairs = new Map(); // packets repaired on the way to the client, by name
    let closing = false;
    const closeRecorder = () => {
        if (closing) return;
        closing = true;
        rec.close().then(({ bytes, summary }) => {
            openRecorders.delete(rec);
            if (repairs.size) console.log(`[Proxy] repaired malformed server packets for the client: ${JSON.stringify([...repairs])} (the reader repairs the same in a capture)`);
            console.log(`[Recorder] Closed ${base} (${bytes} raw bytes). Packets by direction/state/name:`);
            for (const [key, n] of summary) console.log(`  ${String(n).padStart(8)}  ${key}`);
        });
    };

    incomingClient.removeAllListeners('login_acknowledged');
    incomingClient.removeAllListeners('select_known_packs');
    incomingClient.removeAllListeners('finish_configuration');

    let endedTarget = false;
    let endedIncoming = false;
    const toTargetQueue = [];
    const toIncomingQueue = [];

    incomingClient.once('login_acknowledged', () => {
        incomingClient.state = states.CONFIGURATION;
        rec.mark('login', 'configuration', 'login_acknowledged');
        while (toIncomingQueue.length > 0 && !endedIncoming) {
            incomingClient.writeRaw(toIncomingQueue.shift());
        }
    });

    const targetClient = mc.createClient({
        host: TARGET_HOST,
        port: TARGET_PORT,
        username: incomingClient.username,
        auth: 'offline',
        version: VERSION,
        keepAlive: false,
        hideErrors: !SHOW_PARSE_ERRORS // Stops PartialReadError spam on declare_recipes
    });

    const stripTargetAutoResponders = () => {
        targetClient.removeAllListeners('select_known_packs');
        targetClient.removeAllListeners('finish_configuration');
        targetClient.removeAllListeners('start_configuration');
        for (const fn of targetClient.listeners('packet')) {
            const src = fn.toString();
            if (src.includes('select_known_packs') || src.includes('finish_configuration')) {
                targetClient.removeListener('packet', fn);
            }
        }
    };

    stripTargetAutoResponders();
    targetClient.on('success', stripTargetAutoResponders);

    targetClient.on('state', (newState) => {
        stripTargetAutoResponders();
        if (newState === states.CONFIGURATION) {
            while (toTargetQueue.length > 0 && !endedTarget) {
                targetClient.writeRaw(toTargetQueue.shift());
            }
        }
    });

    // ==========================================================================
    // A. RAW PACKET FORWARDING + RAW RECORDING
    //    Every packet is recorded at receipt (before queueing or forwarding), in
    //    every state this proxy sees, so configuration and play are both captured
    //    with a monotonic timestamp. Login is terminated on each leg, so only the
    //    target leg's login packets show up here.
    // ==========================================================================
    incomingClient.on('raw', (buffer, meta) => {
        rec.raw('C2S', meta, buffer);
        if (endedTarget) return;

        if (meta.state === states.CONFIGURATION || meta.state === states.PLAY) {
            if (meta.name === 'login_acknowledged') return;

            if (targetClient.state === meta.state) {
                targetClient.writeRaw(buffer);
            } else if (meta.state === states.CONFIGURATION) {
                toTargetQueue.push(buffer);
            } else {
                rec.count(`dropped C2S ${meta.state} ${meta.name}`);
            }

            if (meta.state === states.CONFIGURATION && meta.name === 'finish_configuration') {
                incomingClient.state = states.PLAY;
                targetClient.state = states.PLAY;
                rec.mark('configuration', 'play', 'finish_configuration');
                console.log(`[Proxy] ${incomingClient.username} entered PLAY state!`);
            } else if (meta.state === states.PLAY && meta.name === 'configuration_acknowledged') {
                incomingClient.state = states.CONFIGURATION;
                targetClient.state = states.CONFIGURATION;
                rec.mark('play', 'configuration', 'configuration_acknowledged');
            }
        }
    });

    targetClient.on('raw', (buffer, meta) => {
        rec.raw('S2C', meta, buffer);
        if (endedIncoming) return;

        if (meta.state === states.CONFIGURATION || meta.state === states.PLAY) {
            if (incomingClient.state === meta.state) {
                // recorded above as received; the client gets it repaired if the library damaged it on the way in (see sanitize.js)
                incomingClient.writeRaw(meta.state === states.PLAY ? sanitize.forServer(meta.name, buffer, repairs) : buffer);
            } else if (meta.state === states.CONFIGURATION) {
                toIncomingQueue.push(buffer);
            } else {
                rec.count(`dropped S2C ${meta.state} ${meta.name}`);
            }
        }
    });

    // ==========================================================================
    // B. PARSED PACKET LOGGING (optional convenience copy of play traffic)
    // ==========================================================================
    incomingClient.on('packet', (data, meta) => {
        if (meta.state !== states.PLAY) return;
        rec.parsed('C2S', meta.name, data);
    });

    targetClient.on('packet', (data, meta) => {
        if (meta.state !== states.PLAY) return;
        rec.parsed('S2C', meta.name, data);
    });

    // ==========================================================================
    // C. CLEAN UP ON DISCONNECT
    // ==========================================================================
    incomingClient.on('end', () => {
        endedIncoming = true;
        if (!endedTarget) targetClient.end('Player disconnected');
        closeRecorder();
    });

    incomingClient.on('error', (err) => {
        endedIncoming = true;
        console.error(`[Incoming Error]`, err.message);
        if (!endedTarget) targetClient.end('Error');
        closeRecorder();
    });

    targetClient.on('end', () => {
        endedTarget = true;
        if (!endedIncoming) incomingClient.end('Backend disconnected');
        closeRecorder();
    });

    targetClient.on('error', (err) => {
        endedTarget = true;
        console.error(`[Backend Error]`, err.message);
        if (!endedIncoming) incomingClient.end('Backend error');
        closeRecorder();
    });
});