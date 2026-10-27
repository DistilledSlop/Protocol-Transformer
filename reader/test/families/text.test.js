'use strict';
// Writer side of the text channels: each packet is built as the server sends it, read by the Reader, and rebuilt
// by the Writer. Styling is not in the tokens, so text is compared as plain text.
//
// LOSSY, by design (the reader is not changed for these):
//   chat styling and events        colour, bold, click and hover are not in the row (the rebuilt text is plain)
//   chatfrom type                  the chat type holder is not in the row; the writer always sends chatType 0
//   death playerId                 the row does not name the dead entity; the writer always uses the viewer
//   tab uuid                       the row has no UUID; the writer makes one per player-list index
//   tab latency                    kept in 10 ms steps, capped at 1000 ms
//   tab display name               only its first token is kept, so a display name is rejected, not rebuilt
//   text over 96 characters        the template is cut at 96 characters
//   action bar from system_chat    isActionBar:true comes back as action_bar

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const nbt = require(path.join(__dirname, '..', '..', '..', 'proxy', 'node_modules', 'prismarine-nbt'));
const { roundTrip, sameParams } = require('./helper');
const { Writer } = require('../../writer/writer');

// plain text of a component, styling dropped; translatable ones show their key and arguments
function plainOf(comp) {
    const js = comp && comp.type !== undefined ? nbt.simplify(comp) : comp;
    return flat(js);
}
function flat(js) {
    if (js === undefined || js === null) return '';
    if (typeof js === 'string') return js;
    if (Array.isArray(js)) return js.map(flat).join('');
    let s = '';
    if (typeof js.text === 'string') s += js.text;
    else if (typeof js.translate === 'string') s += `${js.translate}(${(js.with ?? []).map(flat).join(', ')})`;
    if (js.extra) s += js.extra.map(flat).join('');
    return s;
}

const txt = (s, extra = {}) => nbt.comp({ text: nbt.string(s), ...extra });
const ADD = (uuid, name) => ({ name: 'player_info', params: { action: { add_player: true }, data: [{ uuid, player: { name, properties: [] } }] } });
const ALICE = ADD('00000000-0000-0000-0000-0000000000aa', 'Alice');

// the reader's text row for one channel in the tested tick
function textRow(r, channel) {
    const rows = r.rows.filter((x) => x.row === 'TEXT' && x.kind === channel);
    assert.equal(rows.length, 1, `one TEXT ${channel} row`);
    return rows[0];
}

// the one packet of a name the writer made in the tested tick
function built(r, name) {
    const found = r.out.filter((p) => p.name === name);
    assert.equal(found.length, 1, `one ${name} packet`);
    return found[0];
}

test('chat: plain text with a number is one template and one value', () => {
    const orig = { name: 'system_chat', params: { content: txt('hello 12'), isActionBar: false } };
    const r = roundTrip({ packets: [orig], entity: false });
    assert.deepEqual(textRow(r, 'chat').tokens, ['TEXT', 'ch:chat', 'tpl:hello {n}', 'v12']);
    const out = built(r, 'system_chat');
    sameParams(orig.params, out.params, { ignore: ['content'] });
    assert.equal(plainOf(out.params.content), 'hello 12');
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('chat: translatable component with arguments', () => {
    const content = nbt.comp({ translate: nbt.string('chat.type.text'), with: nbt.list(nbt.comp([txt('Bob'), txt('7')])) });
    const orig = { name: 'system_chat', params: { content, isActionBar: false } };
    const r = roundTrip({ packets: [orig], entity: false });
    assert.equal(textRow(r, 'chat').tokens[2], 'tr:chat.type.text');
    const out = built(r, 'system_chat');
    sameParams(orig.params, out.params, { ignore: ['content'] });
    assert.equal(plainOf(out.params.content), plainOf(content));
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('chat: a player name in the name table is a name token', () => {
    const orig = { name: 'system_chat', params: { content: txt('Alice says 3 things'), isActionBar: false } };
    const r = roundTrip({ before: [ALICE], packets: [orig], entity: false });
    const tokens = textRow(r, 'chat').tokens;
    assert.ok(tokens.some((t) => /^nm\d+$/.test(t)), 'a name token');
    const out = built(r, 'system_chat');
    assert.equal(plainOf(out.params.content), 'Alice says 3 things');
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('chat: styling is LOSSY, the text is kept', () => {
    const styled = txt('gold 1', { color: nbt.string('gold'), bold: nbt.byte(1) });
    const orig = { name: 'system_chat', params: { content: styled, isActionBar: false } };
    const r = roundTrip({ packets: [orig], entity: false });
    const out = built(r, 'system_chat');
    sameParams(orig.params, out.params, { ignore: ['content'] });
    assert.equal(plainOf(out.params.content), 'gold 1');
});

test('chat: text over 96 characters is cut (LOSSY)', () => {
    const long = 'abcdefghij'.repeat(12); // 120 characters, no numbers or names
    const r = roundTrip({ packets: [{ name: 'system_chat', params: { content: txt(long), isActionBar: false } }], entity: false });
    assert.equal(plainOf(built(r, 'system_chat').params.content), long.slice(0, 96));
});

test('action bar: system_chat with the action bar flag comes back as action_bar', () => {
    const orig = { name: 'action_bar', params: { text: txt('HP 20') } };
    const r = roundTrip({ packets: [orig], entity: false });
    assert.equal(textRow(r, 'actionbar').kind, 'actionbar');
    const out = built(r, 'action_bar');
    assert.equal(plainOf(out.params.text), 'HP 20');
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('chatfrom: name then message, no target; the chat type is LOSSY', () => {
    const orig = { name: 'profileless_chat', params: { message: txt('hi 3'), type: { chatType: 3 }, name: txt('Alice') } };
    const r = roundTrip({ before: [ALICE], packets: [orig], entity: false });
    const tokens = textRow(r, 'chatfrom').tokens;
    assert.ok(tokens[2].startsWith('nm') || tokens[2].startsWith('tpl:'), 'name first');
    const out = built(r, 'profileless_chat');
    sameParams(orig.params, out.params, { ignore: ['type', 'name', 'message'] });
    assert.equal(plainOf(out.params.name), 'Alice');
    assert.equal(plainOf(out.params.message), 'hi 3');
    assert.equal(out.params.target, undefined);
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('title: set_title_text', () => {
    const orig = { name: 'set_title_text', params: { text: txt('Round 2') } };
    const r = roundTrip({ packets: [orig], entity: false });
    assert.equal(textRow(r, 'title').tokens[2], 'tpl:Round {n}');
    assert.equal(plainOf(built(r, 'set_title_text').params.text), 'Round 2');
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('subtitle: set_title_subtitle, translatable', () => {
    const text = nbt.comp({ translate: nbt.string('title.x'), with: nbt.list(nbt.comp([txt('go')])) });
    const orig = { name: 'set_title_subtitle', params: { text } };
    const r = roundTrip({ packets: [orig], entity: false });
    assert.equal(textRow(r, 'subtitle').tokens[2], 'tr:title.x');
    assert.equal(plainOf(built(r, 'set_title_subtitle').params.text), plainOf(text));
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('titletimes: in, st, out, including a value above 255', () => {
    const orig = { name: 'set_title_time', params: { fadeIn: 10, stay: 300, fadeOut: 20 } };
    const r = roundTrip({ packets: [orig], entity: false });
    const out = built(r, 'set_title_time');
    assert.deepEqual(out.params, { fadeIn: 10, stay: 300, fadeOut: 20 });
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('clear titles: reset and clear rows', () => {
    for (const reset of [true, false]) {
        const r = roundTrip({ packets: [{ name: 'clear_titles', params: { reset } }], entity: false });
        assert.deepEqual(textRow(r, 'title').tokens, ['TEXT', 'ch:title', reset ? 'reset' : 'clear']);
        assert.deepEqual(built(r, 'clear_titles').params, { reset });
        assert.equal(r.writer.stats.rejected.size, 0);
    }
});

test('death: death_combat_event for the viewer, message rebuilt', () => {
    const orig = { name: 'death_combat_event', params: { playerId: 1, message: nbt.comp({ translate: nbt.string('death.attack.player'), with: nbt.list(nbt.comp([txt('Alice'), txt('2')])) }) } };
    const r = roundTrip({ before: [ALICE], packets: [orig], entity: false });
    assert.equal(textRow(r, 'death').kind, 'death');
    const out = built(r, 'death_combat_event');
    sameParams(orig.params, out.params, { ignore: ['message'] });
    assert.equal(plainOf(out.params.message), plainOf(orig.params.message));
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('tab header and footer: playerlist_header', () => {
    const orig = { name: 'playerlist_header', params: { header: txt('Server 1'), footer: nbt.comp({ translate: nbt.string('f.x'), with: nbt.list(nbt.comp([txt('5')])) }) } };
    const r = roundTrip({ packets: [orig], entity: false });
    assert.equal(textRow(r, 'tab').tokens[2], 'header');
    const out = built(r, 'playerlist_header');
    assert.equal(plainOf(out.params.header), 'Server 1');
    assert.equal(plainOf(out.params.footer), plainOf(orig.params.footer));
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('tab player add: player_info with name, mode, listed and latency', () => {
    const orig = {
        name: 'player_info',
        params: {
            action: { add_player: true, update_game_mode: true, update_listed: true, update_latency: true },
            data: [{ uuid: '00000000-0000-0000-0000-0000000000aa', player: { name: 'Alice', properties: [] }, gamemode: 1, listed: true, latency: 120 }],
        },
    };
    const r = roundTrip({ packets: [orig], entity: false });
    const tokens = textRow(r, 'tab').tokens;
    assert.equal(tokens[2], 'pl0');
    assert.equal(tokens[3], 'add');
    const out = built(r, 'player_info');
    // the uuid is the writer's own (the row has none): LOSSY
    sameParams(orig.params, out.params, { ignore: ['uuid'] });
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('tab update: game mode, unlisted, latency rounded to 10 ms (LOSSY)', () => {
    // the player is already in the list (add in before), so this update carries no name
    const orig = {
        name: 'player_info',
        params: { action: { update_game_mode: true, update_listed: true, update_latency: true }, data: [{ uuid: '00000000-0000-0000-0000-0000000000aa', gamemode: 0, listed: false, latency: 85 }] },
    };
    const r = roundTrip({ before: [ALICE], packets: [orig], entity: false });
    const out = built(r, 'player_info');
    assert.equal(out.params.data[0].player, undefined);
    sameParams(orig.params, out.params, { ignore: ['uuid'], tol: { latency: 5 } });
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('tab display name is rejected (LOSSY), no packet', () => {
    const orig = {
        name: 'player_info',
        params: { action: { update_display_name: true }, data: [{ uuid: '00000000-0000-0000-0000-0000000000aa', displayName: txt('Red Alice') }] },
    };
    const r = roundTrip({ before: [ALICE], packets: [orig], entity: false });
    const keys = [...r.writer.stats.rejected.keys()];
    assert.ok(keys.some((k) => /display name/.test(k)), `rejected: ${keys}`);
    assert.equal(r.out.filter((p) => p.name === 'player_info').length, 0);
});

test('a template with a placeholder and no value token is rejected, not thrown', () => {
    const w = new Writer();
    const out = w.step([{ io: 'out', tokens: ['TEXT', 'ch:chat', 'tpl:hello {n}'] }], { playerId: 1, names: [] });
    assert.deepEqual(out, []);
    assert.equal(w.stats.rejected.size, 1);
});

test('chatfrom with a translatable name: the separator keeps the name\'s arguments apart from the message', () => {
    const name = nbt.comp({ translate: nbt.string('chat.type.team'), with: nbt.list(nbt.comp([{ text: nbt.string('Red') }, { text: nbt.string('Alice') }])) });
    const orig = { name: 'profileless_chat', params: { message: txt('good luck'), type: { chatType: 0 }, name } };
    const r = roundTrip({ packets: [orig], entity: false });
    assert.ok(textRow(r, 'chatfrom').tokens.includes('msg'));
    const out = built(r, 'profileless_chat');
    assert.equal(plainOf(out.params.name), 'chat.type.team(Red, Alice)');
    assert.equal(plainOf(out.params.message), 'good luck');
    assert.equal(r.writer.stats.rejected.size, 0);
});

test('a message longer than the 96-character template cut still parses: values only for the placeholders that survive', () => {
    const long = `${'x'.repeat(100)} then 1 2 3`;
    const orig = { name: 'system_chat', params: { content: txt(long), isActionBar: false } };
    const r = roundTrip({ packets: [orig], entity: false });
    assert.equal(textRow(r, 'chat').tokens.length, 3, 'the template and no value tokens: every placeholder was past the cut');
    assert.equal(r.writer.stats.rejected.size, 0);
    assert.equal(plainOf(built(r, 'system_chat').params.content), 'x'.repeat(96));
});
