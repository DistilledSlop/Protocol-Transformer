#!/usr/bin/env node
'use strict';
// Usage: node engine/live_proxy.js [--port 25570] [--target 127.0.0.1:25565] [--also blocks,slots,globals] [--pass-through] [--record]
//
// Sits between a real client and a real server, like proxy/index.js, but the entity scene the client sees is
// rebuilt live by reader -> writer (see engine/live.js). Connect your client here instead of to the server.
// --pass-through forwards everything untouched (a control: it should look exactly like the server).
// --record also saves the session in the capture format under proxy/data/ (the server's own packets).

const path = require('path');
const { mc } = require(path.join(__dirname, '..', 'reader', 'deps'));
const { createRecorder } = require(path.join(__dirname, '..', 'proxy', 'recorder'));
const { Live } = require('./live');
const sanitize = require(path.join(__dirname, '..', 'proxy', 'sanitize'));
const states = mc.states;

const arg = (n, d) => (process.argv.indexOf(n) > 0 ? process.argv[process.argv.indexOf(n) + 1] : d);
const PORT = +arg('--port', 25570);
const [TARGET_HOST, TARGET_PORT] = arg('--target', '127.0.0.1:25565').split(':');
const ALSO = (arg('--also', '') || '').split(',').filter(Boolean);
const PASS = process.argv.includes('--pass-through');
const RECORD = process.argv.includes('--record');
const VERSION = '1.21.1';
const t0 = process.hrtime.bigint();
const now = () => Number(process.hrtime.bigint() - t0) / 1e6;

const server = mc.createServer({ 'online-mode': false, host: '127.0.0.1', port: PORT, version: VERSION, keepAlive: false, hideErrors: true });
console.log(`[live] listening on 127.0.0.1:${PORT} -> ${TARGET_HOST}:${TARGET_PORT} (${PASS ? 'pass-through' : 'writer' + (ALSO.length ? '+' + ALSO.join('+') : '')}${RECORD ? ', recording' : ''})`);

const openRecorders = new Set();
process.on('SIGINT', () => Promise.all([...openRecorders].map((r) => r.close())).then(() => process.exit(0)));

server.on('login', (incomingClient) => {
    const user = incomingClient.username;
    console.log(`[live] ${user} logging in`);
    let rec = null;
    if (RECORD) {
        rec = createRecorder(path.join(__dirname, '..', 'proxy', 'data', `session_${user}_${Date.now()}`), { logParsed: false });
        rec.header({ version: VERSION, target: `${TARGET_HOST}:${TARGET_PORT}`, username: user, via: 'live_proxy' });
        openRecorders.add(rec);
    }

    const repairs = new Map(); // server packets repaired for the client, by name
    let endedTarget = false;
    let endedIncoming = false;
    const toTargetQueue = [];
    const toIncomingQueue = [];
    const live = PASS
        ? null
        : new Live({
              also: ALSO,
              now,
              log: (m) => console.log(`[live] ${m}`),
              send: (buf) => {
                  if (!endedIncoming && incomingClient.state === states.PLAY) incomingClient.writeRaw(buf);
              },
          });
    const timer = live ? setInterval(() => live.tick(), 10) : null;
    const report = live ? setInterval(() => console.log(`[live] ${live.summary()}`), 15000) : null;
    const cleanup = () => {
        clearInterval(timer);
        clearInterval(report);
        if (live) console.log(`[live] ${user} done: ${live.summary()}`);
        if (repairs.size) console.log(`[live] repaired malformed server packets: ${JSON.stringify([...repairs])}`);
        rec?.close();
    };

    incomingClient.removeAllListeners('login_acknowledged');
    incomingClient.removeAllListeners('select_known_packs');
    incomingClient.removeAllListeners('finish_configuration');
    incomingClient.once('login_acknowledged', () => {
        incomingClient.state = states.CONFIGURATION;
        rec?.mark('login', 'configuration', 'login_acknowledged');
        while (toIncomingQueue.length > 0 && !endedIncoming) incomingClient.writeRaw(toIncomingQueue.shift());
    });

    const targetClient = mc.createClient({ host: TARGET_HOST, port: +TARGET_PORT, username: user, auth: 'offline', version: VERSION, keepAlive: false, hideErrors: true });
    const stripTargetAutoResponders = () => {
        targetClient.removeAllListeners('select_known_packs');
        targetClient.removeAllListeners('finish_configuration');
        targetClient.removeAllListeners('start_configuration');
        for (const fn of targetClient.listeners('packet')) {
            const src = fn.toString();
            if (src.includes('select_known_packs') || src.includes('finish_configuration')) targetClient.removeListener('packet', fn);
        }
    };
    stripTargetAutoResponders();
    targetClient.on('success', stripTargetAutoResponders);
    targetClient.on('state', (newState) => {
        stripTargetAutoResponders();
        if (newState === states.CONFIGURATION) while (toTargetQueue.length > 0 && !endedTarget) targetClient.writeRaw(toTargetQueue.shift());
    });

    // client -> server: forwarded as is, except use_entity on an entity the writer named
    incomingClient.on('raw', (buffer, meta) => {
        rec?.raw('C2S', meta, buffer);
        if (endedTarget) return;
        if (meta.state === states.CONFIGURATION || meta.state === states.PLAY) {
            if (meta.name === 'login_acknowledged') return;
            let out = buffer;
            if (live && meta.state === states.PLAY) out = live.onClientPacket(meta.name, buffer);
            if (out !== null) {
                if (targetClient.state === meta.state) targetClient.writeRaw(out);
                else if (meta.state === states.CONFIGURATION) toTargetQueue.push(out);
            }
            if (meta.state === states.CONFIGURATION && meta.name === 'finish_configuration') {
                incomingClient.state = states.PLAY;
                targetClient.state = states.PLAY;
                rec?.mark('configuration', 'play', 'finish_configuration');
                console.log(`[live] ${user} entered PLAY`);
            } else if (meta.state === states.PLAY && meta.name === 'configuration_acknowledged') {
                incomingClient.state = states.CONFIGURATION;
                targetClient.state = states.CONFIGURATION;
                live?.reset();
                rec?.mark('play', 'configuration', 'configuration_acknowledged');
            }
        }
    });

    // server -> client: the scene is the writer's
    targetClient.on('raw', (buffer, meta) => {
        rec?.raw('S2C', meta, buffer);
        if (endedIncoming) return;
        if (meta.state === states.CONFIGURATION || meta.state === states.PLAY) {
            if (incomingClient.state === meta.state) {
                if (live && meta.state === states.PLAY && !live.onServerPacket(meta.name, buffer)) return;
                incomingClient.writeRaw(meta.state === states.PLAY ? sanitize.forServer(meta.name, buffer, repairs) : buffer);
            } else if (meta.state === states.CONFIGURATION) toIncomingQueue.push(buffer);
        }
    });

    const end = (who, msg) => {
        if (who === 'in') endedIncoming = true;
        else endedTarget = true;
        console.log(`[live] ${who === 'in' ? 'client' : 'server'} side closed${msg ? ': ' + msg : ''}`);
        if (who === 'in' && !endedTarget) targetClient.end('Player disconnected');
        if (who === 'target' && !endedIncoming) incomingClient.end('Backend disconnected');
        cleanup();
    };
    incomingClient.on('end', () => end('in'));
    incomingClient.on('error', (e) => end('in', e.message));
    targetClient.on('end', () => end('target'));
    targetClient.on('error', (e) => end('target', e.message));
});
