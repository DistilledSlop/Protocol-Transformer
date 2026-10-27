#!/usr/bin/env node
'use strict';
// Usage: node engine/model_server.js <world session> --ckpt train/runs/night/best.pt [--port 25569] [--host 127.0.0.1]
//                                    [--also blocks,slots,text,events] [--model-args "--temperature 0.8"]
//
// A Minecraft 1.21.1 server whose scene is made by the trained model. Join with the username in the world
// capture's header (offline mode).
//
//   login, configuration and the world   from the captured session: its join packets and the chunks around the
//                                        first position (engine/schedule.js, mode 'join'). No chunk streaming:
//                                        past the edge of that area there is nothing yet.
//   every tick (50 ms)                   the reader turns what the client sent into input rows; the model
//                                        (train/infer.py serve, a child process) answers with rows; the writer
//                                        compiles them to packets for the client.
//
// The reader also reads the writer's packets back, as it would a server's, so it knows which entities the client
// has (an attack on one becomes an input row naming its slot). Range culling is off: every entity is the model's.
// Families the model owns: 'scene' always, plus --also. Health, XP, weather and game mode ('globals') are left to
// the join packets by default, because a model that writes health 0 leaves the player on the death screen.

const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const R = (p) => path.join(__dirname, '..', 'reader', p);
const { mc } = require(R('deps'));
const { createCodec } = require(R('parse'));
const { Reader } = require(R('reader'));
const { Writer } = require(R('writer/writer'));
const { build } = require('./schedule');
const { writerOwns } = require('./ownership');

function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : def;
}

const base = process.argv[2];
if (!base || base.startsWith('--')) {
    console.error('usage: model_server.js <world session base> --ckpt <best.pt> [--port N] [--host H] [--also blocks,slots,text,events] [--model-args "..."] [--join-speed 4]');
    process.exit(2);
}
const ckpt = arg('--ckpt');
if (!ckpt) {
    console.error('model_server.js needs --ckpt <best.pt>');
    process.exit(2);
}
const PORT = +arg('--port', 25569);
const HOST = arg('--host', '127.0.0.1');
const ALSO = (arg('--also', 'blocks,slots,text,events') || '').split(',').filter(Boolean);
const MODEL_ARGS = (arg('--model-args', '') || '').split(/\s+/).filter(Boolean);
const DATASET = arg('--dataset', path.join(__dirname, '..', 'dataset'));
const JOIN_SPEED = +arg('--join-speed', 4);
// the world clock: keep (as the capture left it, which on a server with the day cycle off is a frozen night), cycle (the day
// runs, from morning), noon or midnight (locked there)
const TIME = arg('--time', 'cycle');
// the engine answering /time itself, for a model that has not learned to: off by default, the model is meant to do it
const ENGINE_TIME = process.argv.includes('--engine-time');
const MAX_BACKLOG = +arg('--max-backlog', 3); // ticks waiting for the model; past this it only reads them
const NEIGHBORS = [[0, 1, 0], [0, -1, 0], [0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0]];
const VERSION = '1.21.1';
const TICK_MS = 50;
const KEEPALIVE_MS = 10000;
const KICK_MS = 25000;
const STATUS_MS = 5000;
const LIVE_PHASE = 25; // the tick boundary sits mid-burst-gap for the client's 20 Hz packets; no capture to estimate from

const log = (...a) => console.log('[model]', ...a);
const t0 = process.hrtime.bigint();
const now = () => Number(process.hrtime.bigint() - t0) / 1e6;

// ---- the model: infer.py serve as a child process, one request at a time ---------------------------------------------
class Model {
    constructor() {
        const trainDir = path.join(__dirname, '..', 'train');
        const args = ['run', 'python', 'infer.py', 'serve', '--ckpt', path.resolve(ckpt), '--dataset', path.resolve(DATASET), ...MODEL_ARGS];
        log(`starting the model: uv ${args.join(' ')}`);
        this.proc = spawn('uv', args, { cwd: trainDir, stdio: ['pipe', 'pipe', 'inherit'] });
        this.waiting = []; // resolvers of requests in flight, in order
        this.dead = false;
        this.ready = new Promise((resolve, reject) => {
            this.waiting.push({ resolve, reject });
        });
        readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
            const w = this.waiting.shift();
            if (!w) return;
            try {
                w.resolve(JSON.parse(line));
            } catch (e) {
                w.reject(new Error(`bad line from the model: ${line.slice(0, 120)}`));
            }
        });
        this.proc.on('exit', (code) => {
            this.dead = true;
            log(`the model process exited (${code})`);
            for (const w of this.waiting.splice(0)) w.reject(new Error('the model process exited'));
        });
        this.proc.on('error', (e) => {
            this.dead = true;
            for (const w of this.waiting.splice(0)) w.reject(e);
        });
    }

    request(obj) {
        if (this.dead) return Promise.reject(new Error('the model process is not running'));
        return new Promise((resolve, reject) => {
            this.waiting.push({ resolve, reject });
            this.proc.stdin.write(JSON.stringify(obj) + '\n');
        });
    }

    stop() {
        this.proc.kill();
    }
}

// ---- one connected player --------------------------------------------------------------------------------------------
class Session {
    constructor(client, sched, model) {
        this.client = client;
        this.sched = sched;
        this.model = model;
        this.alive = true;
        this.live = false;
        this.codec = createCodec(VERSION);
        this.families = new Set(['scene', 'clock', ...ALSO]);
        this.clock = { age: 0, time: 1000, locked: false }; // the engine's time; seeded from the join
        this.reader = new Reader({ phase: LIVE_PHASE, range: Infinity, deferNear: false, terrain: true });
        this.writer = new Writer();
        // a slot the model chose keeps its number when the reader reads the entity back
        this.reader.slotHint = (id) => {
            for (const [slot, e] of this.writer.bySlot) if (e.id === id) return slot;
        };
        this.queue = []; // closed reader ticks waiting for the model
        this.draining = false;
        this.blocks = { rows: 0, legal: 0, floating: 0, unknown: 0 }; // what the model's block rows do to the world it can't see
        this.stats = { ticks: 0, skipped: 0, rows: 0, packets: 0, encodeErrors: 0, modelErrors: 0, ms: 0, maxMs: 0, acks: 0 };
        this.lastStatus = { at: now(), ticks: 0 };
        this.lastKeepAlive = Date.now();
        this.kaId = 1;
        this.timers = [];
    }

    send(buf) {
        if (this.alive) this.client.writeRaw(buf);
    }

    // a packet read as if a server had sent it (what the client now believes)
    echo(name, buf) {
        this.collect(this.reader.feed({ t: now(), dir: 'S2C', state: 'play', name, buf }));
    }

    collect(ticks) {
        for (const tk of ticks) this.queue.push(tk);
        if (this.live && ticks.length) this.drain();
    }

    // ---- what the client sends -----------------------------------------------------------------------------------
    onClientPacket(data, meta) {
        if (meta.state !== 'play') return;
        if (meta.name === 'keep_alive') this.lastKeepAlive = Date.now();
        // block breaking, placing and item use carry a sequence number the client waits to see acknowledged
        if (['block_dig', 'block_place', 'use_item'].includes(meta.name) && data.sequence !== undefined) {
            this.send(this.codec.encode('S2C', 'acknowledge_player_digging', { sequenceId: data.sequence }));
            this.stats.acks++;
        }
        // a command the engine answers itself is not shown to the model, which would only answer it a second time
        if ((meta.name === 'chat_command' || meta.name === 'chat_command_signed') && typeof data.command === 'string' && ENGINE_TIME && this.timeCommand(data.command)) return;
        try {
            this.collect(this.reader.feedPacket({ t: now(), dir: 'C2S', name: meta.name, params: data }));
        } catch (e) {
            log(`reader error on ${meta.name}: ${e.message}`);
        }
    }

    // ---- join: the captured start of the world --------------------------------------------------------------------
    async join() {
        const { play } = this.sched;
        const start = now();
        let i = 0;
        await new Promise((resolve) => {
            const pump = setInterval(() => {
                const at = (now() - start) * JOIN_SPEED;
                while (i < play.length && play[i].t <= at) {
                    const p = play[i++];
                    this.send(p.buf);
                    try {
                        this.echo(p.name, p.buf);
                    } catch (e) {
                        log(`reader error on join packet ${p.name}: ${e.message}`);
                    }
                }
                if (i >= play.length || !this.alive) {
                    clearInterval(pump);
                    resolve();
                }
            }, 5);
            this.timers.push(pump);
        });
        if (!this.alive) return;
        // the model starts from the first tick after the join, with an empty context
        this.queue = [];
        this.reader.advanceTo(now());
        this.startClock();
        await this.model.request({ op: 'reset' });
        this.queue = [];
        this.live = true;
        log(`${this.client.username} is in (${i} join packets). The model is running.`);
        this.timers.push(setInterval(() => this.collect(this.reader.advanceTo(now())), 10));
        this.timers.push(
            setInterval(() => {
                if (Date.now() - this.lastKeepAlive > KICK_MS) return this.client.end('Timed out');
                this.client.write('keep_alive', { keepAliveId: BigInt(this.kaId++) });
            }, KEEPALIVE_MS)
        );
        this.timers.push(setInterval(() => this.status(), STATUS_MS));
    }

    // ---- the clock ------------------------------------------------------------------------------------------------
    startClock() {
        const c = this.clock;
        const s = this.reader.S.clock;
        if (s?.time !== undefined) {
            c.age = Number(s.age);
            c.locked = s.time < 0n;
            c.time = Number(c.locked ? -s.time : s.time);
        }
        if (TIME === 'cycle' && (c.locked || s?.time === undefined)) Object.assign(c, { time: 1000, locked: false });
        else if (TIME === 'noon') Object.assign(c, { time: 6000, locked: true });
        else if (TIME === 'midnight') Object.assign(c, { time: 18000, locked: true });
        this.sendClock();
    }

    sendClock() {
        const c = this.clock;
        const buf = this.codec.encode('S2C', 'update_time', { age: BigInt(c.age), time: BigInt(c.locked ? -Math.max(1, c.time) : c.time) });
        this.send(buf);
        this.echo('update_time', buf);
    }

    // /time set|add|query, done by the engine: a rule, not something to learn from a handful of examples. Returns whether it
    // was handled.
    timeCommand(command) {
        const m = /^time\s+(set|add|query)\s*(\S*)/i.exec(command.trim());
        if (!m) return false;
        const c = this.clock;
        const verb = m[1].toLowerCase();
        const arg = m[2].toLowerCase();
        const named = { day: 1000, noon: 6000, night: 13000, midnight: 18000 };
        const num = /^(\d+)(t|s|d)?$/.exec(arg);
        const amount = num ? Number(num[1]) * { t: 1, s: 20, d: 24000, undefined: 1 }[num[2]] : undefined;
        let shown;
        let key = 'commands.time.set';
        if (verb === 'set' && (named[arg] !== undefined || amount !== undefined)) c.time = shown = named[arg] ?? amount;
        else if (verb === 'add' && amount !== undefined) {
            c.time += amount;
            shown = c.time;
        } else if (verb === 'query') {
            key = 'commands.time.query';
            shown = arg === 'gametime' ? c.age : arg === 'day' ? Math.floor(c.time / 24000) : c.time % 24000;
        } else return false; // not a form handled here: left to the model
        this.sendClock();
        const text = this.writer._componentNbt({ translate: key, args: [{ text: String(shown) }] });
        const buf = this.codec.encode('S2C', 'system_chat', { content: text, isActionBar: false });
        this.send(buf);
        this.echo('system_chat', buf);
        return true;
    }

    // one engine tick: time passes, and every second the client is told (as a vanilla server does)
    tickClock() {
        const c = this.clock;
        c.age++;
        if (!c.locked) c.time++;
        if (c.age % 20 === 0) this.sendClock();
    }

    // ---- one tick: input rows -> model -> writer -> client ----------------------------------------------------------
    async drain() {
        if (this.draining) return;
        this.draining = true;
        try {
            while (this.queue.length && this.alive) await this.process(this.queue.shift(), this.queue.length);
        } catch (e) {
            log(`stopping: ${e.message}`);
            this.client.end('The model stopped');
        } finally {
            this.draining = false;
        }
    }

    async process(tk, backlog) {
        const rows = tk.rows;
        const inRows = rows.filter((r) => r.io === 'in');
        const engRows = rows.filter((r) => r.io === 'eng');
        const gen = backlog <= MAX_BACKLOG;
        let resp;
        try {
            const req = { op: 'tick', in: inRows.map((r) => r.tokens), eng: engRows.map((r) => r.tokens), gen };
            if (tk.terrain) req.terrain = Buffer.from(tk.terrain).toString('base64'); // a new patch every fourth tick
            resp = await this.model.request(req);
        } catch (e) {
            if (this.model.dead) throw e;
            this.stats.modelErrors++;
            return;
        }
        if (resp.error) {
            this.stats.modelErrors++;
            if (this.stats.modelErrors <= 3) log(`model error: ${resp.error}`);
            return;
        }
        this.stats.ticks++;
        this.tickClock();
        if (!gen) this.stats.skipped++;
        this.stats.ms += resp.ms;
        this.stats.maxMs = Math.max(this.stats.maxMs, resp.ms);
        this.stats.rows += resp.out.length;
        if (!tk.player.known || !this.alive) return;

        // the engine rows and the model's rows become packets; the input rows never do, and neither do the reader's
        // own readings of packets already sent (io 'out')
        const outRows = resp.out.map((tokens) => ({ io: 'out', tokens }));
        this.judgeBlocks(outRows, tk.player);
        const packets = this.writer.step([...engRows, ...outRows], { playerId: tk.player.entityId, player: tk.player, names: tk.names, blobs: tk.blobs, world: this.reader.S.world, info: this.reader.info, clock: this.clock });
        for (const pk of packets) {
            if (!writerOwns(pk.name, pk.params, this.families, tk.player.entityId)) continue;
            let buf;
            try {
                buf = this.codec.encode('S2C', pk.name, pk.params);
            } catch (e) {
                this.stats.encodeErrors++;
                continue;
            }
            this.send(buf);
            this.stats.packets++;
            this.echo(pk.name, buf);
        }
    }

    // Is each block the model writes possible where it writes it? Legal: it changes the block, breaks something that is
    // there, and replaces only air, liquid or a plant. Floating: a solid block with air on all six sides.
    judgeBlocks(rows, player) {
        const w = this.reader.S.world;
        const info = this.reader.info;
        const cat = this.reader.cat;
        for (const r of rows) {
            const t = r.tokens;
            if (t[0] !== 'BLOCK' || !t[4]?.startsWith('blk:')) continue;
            const o = [1, 2, 3].map((i) => Number(/-?\d+$/.exec(t[i])?.[0]));
            const x = Math.floor(player.x) + o[0];
            const y = Math.floor(player.y) + o[1];
            const z = Math.floor(player.z) + o[2];
            let next;
            try {
                next = cat.blockStateId(t[4].slice(4));
            } catch (e) {
                this.blocks.unknown++;
                continue;
            }
            const old = w.get(x, y, z);
            this.blocks.rows++;
            if (old === undefined || next === old) continue;
            const replaceable = info.isAir(old) || info.isLiquid(old) || info.category(old) === 7;
            if (info.isAir(next) ? !info.isAir(old) : replaceable) this.blocks.legal++;
            if (info.isSolid(next) && NEIGHBORS.every(([dx, dy, dz]) => { const n = w.get(x + dx, y + dy, z + dz); return n === undefined || info.isAir(n); })) this.blocks.floating++;
        }
    }

    status() {
        const s = this.stats;
        const rej = [...this.writer.stats.rejected].sort((a, b) => b[1] - a[1]).slice(0, 3);
        // ticks the model has answered (or read, when behind) per second since the last line; 20 is full speed
        const at = now();
        const tps = ((s.ticks - this.lastStatus.ticks) * 1000) / Math.max(1, at - this.lastStatus.at);
        this.lastStatus = { at, ticks: s.ticks };
        log(
            `TPS ${tps.toFixed(1)} | ${s.ticks} ticks (${s.skipped} read only), ${s.rows} rows, ${s.packets} packets sent; model ${(s.ms / Math.max(1, s.ticks - s.skipped)).toFixed(0)} ms/tick, max ${s.maxMs.toFixed(0)}; ` +
                `backlog ${this.queue.length}; entities ${this.writer.bySlot.size}; clamped ${this.writer.stats.clamped ?? 0}; blocks ${this.blocks.rows} (legal ${this.blocks.legal}, floating ${this.blocks.floating}); rejected ${JSON.stringify(rej)}`
        );
    }

    close() {
        this.alive = false;
        for (const t of this.timers) clearInterval(t);
        this.queue = [];
    }
}

// ---- main ------------------------------------------------------------------------------------------------------------
const sched = build(base, { mode: 'join', also: ALSO });
log(`world ${path.basename(base)}: ${sched.config.length} configuration packets, ${sched.play.length} join packets (${(sched.durationMs / 1000).toFixed(1)} s), player entity ${sched.playerId}; the model owns scene+${ALSO.join('+') || 'nothing else'}`);

const model = new Model();
model.ready.then(
    (hello) => {
        log(`the model is ready (vocabulary ${hello.vocab}, context ${hello.ctx})`);
        const server = mc.createServer({ 'online-mode': false, host: HOST, port: PORT, version: VERSION, keepAlive: false, hideErrors: false, maxPlayers: 1 });
        console.log(`[model] listening on ${HOST}:${PORT}. Join with Minecraft ${VERSION}, username ${sched.header.username}`);
        server.on('login', (client) => onLogin(client));
    },
    (e) => {
        console.error('[model] could not start the model:', e.message);
        process.exit(1);
    }
);

const once = (client, ev, ms = 20000) =>
    new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out waiting for ${ev}`)), ms);
        client.once(ev, (...a) => {
            clearTimeout(t);
            resolve(a);
        });
        client.once('end', () => reject(new Error(`client left while waiting for ${ev}`)));
    });

function onLogin(client) {
    log(`${client.username} logging in (${client.uuid})`);
    if (client.username !== sched.header.username) log(`WARNING: the world was recorded as ${sched.header.username}; the player list entry will not match ${client.username}`);
    const session = new Session(client, sched, model);
    client.removeAllListeners('login_acknowledged');
    client.on('packet', (data, meta) => session.onClientPacket(data, meta));
    client.on('error', (e) => log('client error:', e.message));
    client.on('end', (reason) => {
        log(`${client.username} left (${reason})`);
        if (session.live) session.status();
        session.close();
    });
    client.once('login_acknowledged', async () => {
        try {
            client.state = mc.states.CONFIGURATION;
            for (const p of sched.config) {
                client.writeRaw(p.buf);
                if (p.name === 'select_known_packs') await once(client, 'select_known_packs');
            }
            await once(client, 'finish_configuration');
            client.state = mc.states.PLAY;
            await session.join();
        } catch (e) {
            log(`stopped: ${e.message}`);
            client.end('setup failed');
        }
    });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        model.stop();
        process.exit(0);
    });
}
process.on('exit', () => model.stop());
