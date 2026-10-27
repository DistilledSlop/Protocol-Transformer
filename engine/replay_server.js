#!/usr/bin/env node
'use strict';
// Usage: node engine/replay_server.js <session base> [--port 25567] [--mode raw|writer] [--also blocks,slots,globals]
//                                      [--speed 1] [--exit-when-done]
//
// A stand-in for a Minecraft server that streams a capture to whoever connects: offline-mode login, the
// captured configuration (waiting for the client's Known Packs reply and Finish Configuration ack, as a
// real server does), then the play packets on the captured timeline. Keep-alives run on their own timer.
// Connect with the username in the capture header (it fixes the offline UUID the captured join packets use).

const path = require('path');
const { mc } = require(path.join(__dirname, '..', 'reader', 'deps'));
const { build } = require('./schedule');

function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : def;
}

const base = process.argv[2];
if (!base || base.startsWith('--')) {
    console.error('usage: replay_server.js <session base> [--port N] [--mode raw|writer] [--also blocks,slots,globals] [--speed X] [--exit-when-done]');
    process.exit(2);
}
const PORT = +arg('--port', 25567);
const MODE = arg('--mode', 'raw');
const ALSO = (arg('--also', '') || '').split(',').filter(Boolean);
const SPEED = +arg('--speed', 1);
const EXIT_WHEN_DONE = process.argv.includes('--exit-when-done');
const VERSION = '1.21.1';
const KEEPALIVE_MS = 10000;
const KICK_MS = 25000;

const sched = build(base, { mode: MODE, also: ALSO });
console.log(`[replay] ${base}: mode ${MODE}${ALSO.length ? '+' + ALSO.join('+') : ''}, ${sched.config.length} configuration packets, ${sched.play.length} play packets over ${(sched.durationMs / 1000).toFixed(1)} s, player entity ${sched.playerId}`);
if (sched.writerStats) console.log('[replay] writer rejected:', JSON.stringify([...sched.writerStats.rejected].sort((a, b) => b[1] - a[1]).slice(0, 6)));

const server = mc.createServer({ 'online-mode': false, host: '127.0.0.1', port: PORT, version: VERSION, keepAlive: false, hideErrors: false, maxPlayers: 2 });
console.log(`[replay] listening on port ${PORT}; connect with username ${sched.header.username} (Minecraft ${VERSION})`);

const once = (client, ev, ms = 20000) =>
    new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out waiting for ${ev}`)), ms);
        client.once(ev, (...a) => {
            clearTimeout(t);
            resolve(a);
        });
        client.once('end', () => reject(new Error(`client left while waiting for ${ev}`)));
    });

server.on('login', (client) => {
    console.log(`[replay] ${client.username} logging in (${client.uuid})`);
    if (client.username !== sched.header.username) console.log(`[replay] WARNING: the capture was recorded as ${sched.header.username}; player info packets will not match this client's UUID`);
    const recent = [];
    const sent = new Map();
    const received = new Map();
    let playStart = null;
    let pump = null;
    let kaTimer = null;
    let lastKeepAlive = Date.now();
    let kaId = 1;

    client.removeAllListeners('login_acknowledged');
    client.on('packet', (data, meta) => received.set(meta.name, (received.get(meta.name) || 0) + 1));
    client.on('keep_alive', () => (lastKeepAlive = Date.now()));
    const ended = () => {
        clearInterval(pump);
        clearInterval(kaTimer);
        const at = playStart ? ((Date.now() - playStart) / 1000).toFixed(1) : 'before play';
        console.log(`[replay] ${client.username} gone at ${at} s. last packets sent: ${recent.join(' ')}`);
        console.log('[replay] received from client:', JSON.stringify([...received].sort((a, b) => b[1] - a[1]).slice(0, 12)));
    };
    client.on('end', (reason) => {
        console.log(`[replay] end: ${reason}`);
        ended();
        if (EXIT_WHEN_DONE) setTimeout(() => process.exit(0), 200);
    });
    client.on('error', (e) => console.log('[replay] client error:', e.message));

    client.once('login_acknowledged', async () => {
        try {
            client.state = mc.states.CONFIGURATION;
            for (const p of sched.config) {
                client.writeRaw(p.buf);
                if (p.name === 'select_known_packs') {
                    const [reply] = await once(client, 'select_known_packs');
                    const mine = JSON.stringify(reply.packs ?? reply);
                    const theirs = JSON.stringify(sched.knownPacks?.packs ?? sched.knownPacks);
                    console.log(`[replay] client Known Packs: ${mine} (recorded client: ${theirs}) ${mine === theirs ? 'match' : 'DIFFERENT: the replayed registry data may not fit this client'}`);
                }
            }
            await once(client, 'finish_configuration');
            client.state = mc.states.PLAY;
            console.log('[replay] configuration done, starting play');

            playStart = Date.now();
            let i = 0;
            pump = setInterval(() => {
                const now = (Date.now() - playStart) * SPEED;
                while (i < sched.play.length && sched.play[i].t <= now) {
                    const p = sched.play[i++];
                    client.writeRaw(p.buf);
                    sent.set(p.name, (sent.get(p.name) || 0) + 1);
                    recent.push(p.name);
                    if (recent.length > 12) recent.shift();
                }
                if (i >= sched.play.length) {
                    clearInterval(pump);
                    console.log(`[replay] replay finished (${i} packets); the client stays connected, Ctrl+C to stop`);
                    console.log('[replay] sent:', JSON.stringify([...sent].sort((a, b) => b[1] - a[1]).slice(0, 14)));
                    if (EXIT_WHEN_DONE) setTimeout(() => client.end('replay finished'), 1500);
                }
            }, 5);
            kaTimer = setInterval(() => {
                if (Date.now() - lastKeepAlive > KICK_MS) return client.end('Timed out');
                client.write('keep_alive', { keepAliveId: BigInt(kaId++) });
            }, KEEPALIVE_MS);
        } catch (e) {
            console.log(`[replay] stopped: ${e.message}`);
            client.end('replay setup failed');
        }
    });
});
