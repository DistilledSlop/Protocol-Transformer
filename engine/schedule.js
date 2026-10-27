'use strict';
// Turns a capture into what a replay server sends: the configuration packets, then the play packets with
// the time offset each goes out at. Two modes:
//   raw     every server packet verbatim (the join, configuration, chunks, the scene), keep-alives aside
//   writer  the entity scene (and optionally blocks, slots, globals) comes from reader -> rows -> writer
//           instead; packets about other entities that the writer does not rebuild are dropped
//   join    only the start of the capture, for a server whose model supplies the rest: the login, the first
//           position and the chunks around it, with what the writer owns left out. It ends where the player's
//           chunk view first moves (the second View Position packet), since chunk streaming is not built.

const path = require('path');
const { loadCapture, events } = require(path.join(__dirname, '..', 'reader', 'capture'));
const { estimatePhase } = require(path.join(__dirname, '..', 'reader', 'phase'));
const { createCodec } = require(path.join(__dirname, '..', 'reader', 'parse'));
const { Reader } = require(path.join(__dirname, '..', 'reader', 'reader'));
const { Writer } = require(path.join(__dirname, '..', 'reader', 'writer', 'writer'));

const { NEVER, ownedNames, dropForWriter, writerOwns } = require('./ownership');
const sanitize = require(path.join(__dirname, '..', 'proxy', 'sanitize'));

function build(base, { mode = 'raw', also = [] } = {}) {
    const cap = loadCapture(base);
    const codec = createCodec(cap.header.version);
    const toPlay = cap.markers.find((m) => m.from === 'configuration' && m.to === 'play');
    if (!toPlay) throw new Error('capture has no configuration -> play marker');

    const config = [];
    let knownPacks = null; // what the recorded client answered; a replay is only valid for a client that answers the same
    const configCodec = createCodec(cap.header.version, 'configuration');
    for (const p of cap.packets) {
        if (p.state !== 'configuration') continue;
        const buf = cap.bin.subarray(p.off, p.off + p.len);
        if (p.dir === 'S2C') config.push({ name: p.name, buf });
        else if (p.name === 'select_known_packs') knownPacks = configCodec.parse('C2S', buf).params;
    }

    const playCodec = createCodec(cap.header.version, 'play');
    const out = [];
    let seq = 0;
    // captured bytes go out as the proxies would send them: a multi-entry Set Equipment the library damaged is repaired
    const push = (t, name, buf) => out.push({ t, name, buf: sanitize.forServer(name, buf), seq: seq++ });

    let playerId = null;
    const families = new Set(['scene', ...also]);
    const owned = ownedNames(families);

    const phase = mode === 'join' ? 0 : estimatePhase(cap).phase;
    let joinEnd = Infinity;
    if (mode === 'join') {
        const views = cap.packets.filter((p) => p.state === 'play' && p.dir === 'S2C' && p.name === 'update_view_position');
        joinEnd = views.length > 1 ? views[1].t - toPlay.t : 10000;
    }
    for (const p of cap.packets) {
        if (p.state !== 'play' || p.dir !== 'S2C') continue;
        if (p.name === 'login') playerId = playCodec.parse('S2C', cap.bin.subarray(p.off, p.off + p.len)).params.entityId;
        if (NEVER.has(p.name)) continue;
        const buf = cap.bin.subarray(p.off, p.off + p.len);
        const t = Math.max(0, p.t - toPlay.t);
        if (t >= joinEnd) break;
        if (mode === 'raw') {
            push(t, p.name, buf);
            continue;
        }
        // writer mode: drop what the writer replaces
        if (dropForWriter(p.name, owned, playerId, () => playCodec.parse('S2C', buf).params, families)) continue;
        push(t, p.name, buf);
    }

    if (mode === 'writer') {
        const reader = new Reader({ phase });
        const writer = new Writer();
        const handle = (tk) => {
            if (!tk.player.known) return;
            const t = Math.max(0, phase + (tk.tick + 1) * 50 - toPlay.t);
            for (const pk of writer.step(tk.rows, { playerId: tk.player.entityId, player: tk.player, names: tk.names, blobs: tk.blobs })) {
                if (!writerOwns(pk.name, pk.params, families, tk.player.entityId)) continue;
                push(t, pk.name, playCodec.encode('S2C', pk.name, pk.params));
            }
        };
        for (const ev of events(cap)) for (const tk of reader.feed(ev)) handle(tk);
        for (const tk of reader.flush()) handle(tk);
        out.writerStats = writer.stats;
    }

    out.sort((a, b) => a.t - b.t || a.seq - b.seq);
    return { header: cap.header, config, knownPacks, play: out, playerId, durationMs: out.length ? out[out.length - 1].t : 0, writerStats: out.writerStats };
}

module.exports = { build };
