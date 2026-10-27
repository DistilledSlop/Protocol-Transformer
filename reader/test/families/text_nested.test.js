'use strict';
// Nested translatable text components: each argument of a translatable is a component of its own, read as
// `tr:<key> a<n>` followed by n argument components. Each test feeds system_chat packets to a Reader, checks the
// TEXT chat row's tokens, then rebuilds the packet with the Writer and compares the simplified JSON.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const nbt = require(path.join(__dirname, '..', '..', '..', 'proxy', 'node_modules', 'prismarine-nbt'));
const { makeReader } = require('../helpers');
const { checkWire } = require('./helper');
const { Writer } = require('../../writer/writer');

// plain JSON -> an NBT component (text, translate, with, extra). A list of compounds takes the raw tag maps,
// which is how prismarine-nbt stores them: nbt.comp([...]) inside a list would give empty elements.
function raw(js) {
    const o = {};
    for (const [k, v] of Object.entries(js)) {
        if (typeof v === 'string') o[k] = nbt.string(v);
        else if (Array.isArray(v)) o[k] = { type: 'list', value: { type: 'compound', value: v.map(raw) } };
        else throw new Error(`unsupported value for ${k}`);
    }
    return o;
}
function mk(js) {
    return nbt.comp(raw(js));
}

// feed the packets in order and return the reader's rows and the writer's packets for every closed tick
function run(contents, { legacyWriter = null } = {}) {
    const reader = makeReader();
    const writer = new Writer();
    const rows = [];
    const out = [];
    const handle = (tk) => {
        if (!tk.player.known) return;
        const r = tk.rows.filter((x) => x.io !== 'in');
        rows.push(...r);
        out.push(...writer.step(r, { playerId: tk.player.entityId, player: tk.player, names: tk.names, blobs: tk.blobs }));
    };
    const feed = (p) => {
        for (const tk of reader.feedPacket(p)) handle(tk);
    };
    feed({ t: 0, dir: 'S2C', name: 'login', params: { entityId: 1, worldState: { dimension: 0, name: 'minecraft:overworld' } } });
    feed({ t: 1, dir: 'S2C', name: 'position', params: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, flags: {}, teleportId: 1 } });
    let t = 110;
    for (const content of contents) {
        feed({ t, dir: 'S2C', name: 'system_chat', params: { content, isActionBar: false } });
        t += 10;
    }
    feed({ t: 110 + 50 * 4, dir: 'S2C', name: 'update_time', params: { age: 0n, time: 0n } });
    for (const tk of reader.flush()) handle(tk);
    for (const p of out) checkWire(p);
    return { reader, writer, rows, out };
}

// the TEXT chat tokens of the only chat row in a run
function chatTokens(rows) {
    const found = rows.filter((x) => x.row === 'TEXT' && x.kind === 'chat');
    assert.equal(found.length, 1, 'one TEXT chat row');
    return found[0].tokens;
}

// the content of the only system_chat packet in a run, simplified to plain JSON
function chatJson(out) {
    const found = out.filter((p) => p.name === 'system_chat');
    assert.equal(found.length, 1, 'one system_chat packet');
    return nbt.simplify(found[0].params.content);
}

test('nested: a translatable argument stays a translate, not text', () => {
    const js = { translate: 'commands.gamemode.success.self', with: [{ translate: 'gameMode.survival' }] };
    const r = run([mk(js)]);
    assert.deepEqual(chatTokens(r.rows), ['TEXT', 'ch:chat', 'tr:commands.gamemode.success.self', 'a1', 'tr:gameMode.survival', 'a0']);
    assert.deepEqual(chatJson(r.out), js);
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('nested: two levels of translatable arguments, with a plain name in between', () => {
    const js = {
        translate: 'chat.type.advancement.task',
        with: [
            { text: 'Steve' },
            { translate: 'chat.square_brackets', with: [{ translate: 'advancements.story.root.title' }] },
        ],
    };
    const r = run([mk(js)]);
    assert.deepEqual(chatTokens(r.rows), [
        'TEXT', 'ch:chat',
        'tr:chat.type.advancement.task', 'a2',
        'tpl:Steve',
        'tr:chat.square_brackets', 'a1',
        'tr:advancements.story.root.title', 'a0',
    ]);
    assert.deepEqual(chatJson(r.out), js);
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('nested: an empty root wrapping one translatable is read as that translatable', () => {
    const inner = { translate: 'multiplayer.player.joined', with: [{ text: 'Alex' }] };
    const r = run([mk({ text: '', extra: [inner] })]);
    assert.deepEqual(chatTokens(r.rows), ['TEXT', 'ch:chat', 'tr:multiplayer.player.joined', 'a1', 'tpl:Alex']);
    assert.deepEqual(chatJson(r.out), inner);
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('plain text still reads and rebuilds', () => {
    const r = run([mk({ text: 'hello' })]);
    assert.deepEqual(chatTokens(r.rows), ['TEXT', 'ch:chat', 'tpl:hello']);
    assert.deepEqual(chatJson(r.out), { text: 'hello' });
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('legacy rows without a<n> still rebuild: one text argument', () => {
    const w = new Writer();
    const out = w.step([{ io: 'out', tokens: ['TEXT', 'ch:chat', 'tr:commands.gamemode.success.self', 'tpl:gameMode.survival'] }], { playerId: 1, names: [] });
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'system_chat');
    assert.deepEqual(nbt.simplify(out[0].params.content), { translate: 'commands.gamemode.success.self', with: [{ text: 'gameMode.survival' }] });
    assert.equal(w.stats.rejected.size, 0);
});

test('garbage: too many arguments (a99) is rejected, no packet', () => {
    const w = new Writer();
    const out = w.step([{ io: 'out', tokens: ['TEXT', 'ch:chat', 'tr:x', 'a99'] }], { playerId: 1, names: [] });
    assert.deepEqual(out, []);
    assert.ok(w.stats.rejected.size > 0, 'counted as rejected');
});

test('garbage: a row ending before its arguments is rejected, no packet', () => {
    const w = new Writer();
    const out = w.step([{ io: 'out', tokens: ['TEXT', 'ch:chat', 'tr:x', 'a2', 'tpl:one'] }], { playerId: 1, names: [] });
    assert.deepEqual(out, []);
    assert.ok(w.stats.rejected.size > 0, 'counted as rejected');
});

test('depth cap: a translatable nested six deep reads without throwing and gives finite tokens', () => {
    let js = { text: 'bottom' };
    for (let i = 0; i < 6; i++) js = { translate: `level.${i}`, with: [js] };
    let r;
    assert.doesNotThrow(() => {
        r = run([mk(js)]);
    });
    const tokens = chatTokens(r.rows);
    assert.ok(Array.isArray(tokens) && tokens.length > 0 && tokens.length < 100, 'a finite token row');
    assert.ok(tokens.every((t) => typeof t === 'string'), 'every token is a string');
});
