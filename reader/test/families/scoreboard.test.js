'use strict';
// Writer side of the boss-bar, objective, score and team text rows: an original server packet -> the reader's
// TEXT row -> the writer's packet. Text is compared as plain text (styling is not in the tokens), and the
// engine-owned names (bar UUIDs, objective and team names) are checked for stability, not for value.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { roundTrip, sameParams } = require('./helper');
const { Writer } = require('../../writer/writer');

const nbt = require(path.join(__dirname, '..', '..', '..', 'proxy', 'node_modules', 'prismarine-nbt'));

// an anonymous NBT text component, as the 1.21.1 packets carry it
const comp = (text) => ({ type: 'compound', name: '', value: { text: { type: 'string', value: text } } });

// NBT text fields -> plain text, so styling and NBT shape do not take part in the comparison
const TEXT_KEYS = ['title', 'displayText', 'display_name', 'name', 'prefix', 'suffix'];
function plainParams(params) {
    const out = { ...params };
    for (const k of TEXT_KEYS) if (out[k] && typeof out[k] === 'object') out[k] = nbt.simplify(out[k]);
    return out;
}

// player_info with add_player: puts names in the reader's name table (nm<k>), one tick before the tested one
const addPlayers = (...names) =>
    names.map((name, i) => ({
        name: 'player_info',
        params: {
            action: { add_player: true, initialize_chat: false, update_game_mode: false, update_listed: false, update_latency: false, update_display_name: false },
            data: [{ uuid: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, player: { name, properties: [] } }],
        },
    }));

// The reader's TEXT row for one channel in the tested tick, with the given head token (act:..., mode:...)
function textRow(r, channel, head) {
    const rows = r.rows.filter((x) => x.row === 'TEXT' && x.channel === channel && x.tokens.includes(head));
    assert.equal(rows.length, 1, `one ${channel} row with ${head}`);
    return rows[0];
}

// Round-trip the given packets (all in one tick) and check nothing was rejected
function trip(packets, { names = ['Steve', 'Alex'] } = {}) {
    const r = roundTrip({ before: addPlayers(...names), packets, entity: false });
    assert.equal(r.writer.stats.rejected.size, 0, [...r.writer.stats.rejected.keys()].join('; '));
    return r;
}

// The writer's packet of the original's name, compared field by field. Engine-owned fields are in `ignore`.
function same(r, original, { ignore = [], tol = {} } = {}) {
    const got = r.out.filter((p) => p.name === original.name);
    assert.equal(got.length, 1, `one ${original.name} packet`);
    sameParams(plainParams(original.params), plainParams(got[0].params), { ignore, tol });
    return got[0].params;
}

// ---- boss bars ------------------------------------------------------------------------------------------

test('bossbar add: title, health, colour, dividers and flags round trip', () => {
    const original = { name: 'boss_bar', params: { entityUUID: '00000000-0000-0000-0000-0000000000aa', action: 0, title: comp('Boss 3'), health: 0.5, color: 1, dividers: 6, flags: 5 } };
    const r = trip([original]);
    assert.ok(textRow(r, 'bossbar', 'act:add'));
        same(r, original, { ignore: ['entityUUID'] });
});

test('bossbar health: a fraction of 64 round trips', () => {
    const original = { name: 'boss_bar', params: { entityUUID: '00000000-0000-0000-0000-0000000000aa', action: 2, health: 0.25 } };
    const r = trip([original]);
    textRow(r, 'bossbar', 'act:health');
    same(r, original, { ignore: ['entityUUID'] });
});

test('bossbar title: the title group round trips', () => {
    const original = { name: 'boss_bar', params: { entityUUID: '00000000-0000-0000-0000-0000000000aa', action: 3, title: comp('Wave 2') } };
    const r = trip([original]);
    textRow(r, 'bossbar', 'act:title');
    same(r, original, { ignore: ['entityUUID'] });
});

test('bossbar style: colour and dividers round trip', () => {
    const original = { name: 'boss_bar', params: { entityUUID: '00000000-0000-0000-0000-0000000000aa', action: 4, color: 3, dividers: 10 } };
    const r = trip([original]);
    textRow(r, 'bossbar', 'act:style');
    same(r, original, { ignore: ['entityUUID'] });
});

test('bossbar flags: the set bits round trip', () => {
    const original = { name: 'boss_bar', params: { entityUUID: '00000000-0000-0000-0000-0000000000aa', action: 5, flags: 6 } };
    const r = trip([original]);
    textRow(r, 'bossbar', 'act:flags');
    same(r, original, { ignore: ['entityUUID'] });
});

test('bossbar remove: only the bar is named', () => {
    const original = { name: 'boss_bar', params: { entityUUID: '00000000-0000-0000-0000-0000000000aa', action: 1 } };
    const r = trip([original]);
    textRow(r, 'bossbar', 'act:remove');
    same(r, original, { ignore: ['entityUUID'] });
});

test('bossbar uuids: the same bar gets the same UUID in every row, another bar a different one', () => {
    const A = '00000000-0000-0000-0000-0000000000aa';
    const B = '00000000-0000-0000-0000-0000000000bb';
    const r = trip([
        { name: 'boss_bar', params: { entityUUID: A, action: 0, title: comp('A'), health: 1, color: 0, dividers: 0, flags: 0 } },
        { name: 'boss_bar', params: { entityUUID: A, action: 2, health: 0.5 } },
        { name: 'boss_bar', params: { entityUUID: B, action: 2, health: 0.5 } },
    ]);
    const bars = r.out.filter((p) => p.name === 'boss_bar');
    assert.equal(bars.length, 3);
    assert.equal(bars[0].params.entityUUID, bars[1].params.entityUUID);
    assert.notEqual(bars[0].params.entityUUID, bars[2].params.entityUUID);
});

test('bossbar garbage tokens are rejected and counted, not thrown', () => {
    const w = new Writer();
    const ctx = { playerId: 1, player: { x: 0, y: 64, z: 0 }, names: [] };
    const bad = [
        ['TEXT', 'ch:bossbar', 'act:add', 'b0', 'tpl:x', 'h10', 'col0', 'div0', 'bits0', 'junk'],
        ['TEXT', 'ch:bossbar', 'act:bogus', 'b0'],
        ['TEXT', 'ch:bossbar', 'act:health', 'b0'],
    ];
    let out;
    assert.doesNotThrow(() => {
        out = w.step(bad.map((tokens) => ({ io: 'out', tokens })), ctx);
    });
    assert.deepEqual(out, []);
    assert.equal([...w.stats.rejected.values()].reduce((a, b) => a + b, 0), 3);
});

// ---- objectives and their display slot -----------------------------------------------------------------

test('objective create: display text and type round trip, the name is engine-owned', () => {
    const original = { name: 'scoreboard_objective', params: { name: 'kills', action: 0, displayText: comp('Kills'), type: 0 } };
    const r = trip([original]);
    textRow(r, 'objective', 'act:create');
    same(r, original, { ignore: ['name'] });
});

test('objective update: a type of 1 round trips', () => {
    const original = { name: 'scoreboard_objective', params: { name: 'points', action: 2, displayText: comp('Points 5'), type: 1 } };
    const r = trip([original]);
    textRow(r, 'objective', 'act:update');
    same(r, original, { ignore: ['name'] });
});

test('objective remove: only the objective is named', () => {
    const original = { name: 'scoreboard_objective', params: { name: 'kills', action: 1 } };
    const r = trip([original]);
    textRow(r, 'objective', 'act:remove');
    same(r, original, { ignore: ['name'] });
});

test('objective number format is LOST: the reader does not carry it, the client gets the default', () => {
    const original = { name: 'scoreboard_objective', params: { name: 'kills', action: 0, displayText: comp('Kills'), type: 0, number_format: 0 } };
    const r = trip([original]);
    same(r, original, { ignore: ['name', 'number_format', 'styling'] });
    assert.equal(r.out.find((p) => p.name === 'scoreboard_objective').params.number_format, undefined);
});

test('display slot: the position and the objective name round trip, and match the objective the same tick named', () => {
    const create = { name: 'scoreboard_objective', params: { name: 'kills', action: 0, displayText: comp('Kills'), type: 0 } };
    const display = { name: 'scoreboard_display_objective', params: { position: 1, name: 'kills' } };
    const r = trip([create, display]);
    textRow(r, 'objective', 'display');
    const got = r.out.find((p) => p.name === 'scoreboard_display_objective').params;
    assert.equal(got.position, 1);
    assert.equal(got.name, r.out.find((p) => p.name === 'scoreboard_objective').params.name);
});

// ---- scores ----------------------------------------------------------------------------------------------

test('score: the value and the objective it names round trip', () => {
    const create = { name: 'scoreboard_objective', params: { name: 'kills', action: 0, displayText: comp('Kills'), type: 0 } };
    const score = { name: 'scoreboard_score', params: { itemName: 'Steve', scoreName: 'kills', value: 3 } };
    const r = trip([create, score]);
    textRow(r, 'score', 'o0');
    const got = same(r, score, { ignore: ['scoreName'] });
    assert.equal(got.scoreName, r.out.find((p) => p.name === 'scoreboard_objective').params.name);
});

test('score: negative and large values round trip', () => {
    for (const value of [-5, 1000]) {
        const r = trip([{ name: 'scoreboard_score', params: { itemName: 'Alex', scoreName: 'kills', value } }]);
        same(r, { name: 'scoreboard_score', params: { itemName: 'Alex', scoreName: 'kills', value } }, { ignore: ['scoreName'] });
    }
});

test('score with a display name: the text group round trips', () => {
    const score = { name: 'scoreboard_score', params: { itemName: 'Steve', scoreName: 'kills', value: 3, display_name: comp('Kills: 3') } };
    const r = trip([score]);
    same(r, score, { ignore: ['scoreName'] });
});

test('reset score with an objective: the entity and the objective round trip', () => {
    const create = { name: 'scoreboard_objective', params: { name: 'kills', action: 0, displayText: comp('Kills'), type: 0 } };
    const reset = { name: 'reset_score', params: { entity_name: 'Steve', objective_name: 'kills' } };
    const r = trip([create, reset]);
    textRow(r, 'score', 'reset');
    const got = same(r, reset, { ignore: ['objective_name'] });
    assert.equal(got.objective_name, r.out.find((p) => p.name === 'scoreboard_objective').params.name);
});

test('reset score without an objective: the objective stays unset', () => {
    const reset = { name: 'reset_score', params: { entity_name: 'Alex' } };
    const r = trip([reset]);
    const got = same(r, reset);
    assert.equal(got.objective_name, undefined);
});

// ---- teams -----------------------------------------------------------------------------------------------

test('team create: every field round trips, members included, the team name is engine-owned', () => {
    const original = {
        name: 'teams',
        params: { team: 'red', mode: 0, name: comp('Red'), friendlyFire: 3, nameTagVisibility: 'never', collisionRule: 'always', formatting: 12, prefix: comp('[R] '), suffix: comp(''), players: ['Steve', 'Alex'] },
    };
    const r = trip([original]);
    textRow(r, 'team', 'mode:create');
    same(r, original, { ignore: ['team'] });
});

test('team update: a negative formatting (no colour) and a collision rule round trip, no members', () => {
    const original = {
        name: 'teams',
        params: { team: 'blue', mode: 2, name: comp('Blue'), friendlyFire: 0, nameTagVisibility: 'always', collisionRule: 'pushOtherTeams', formatting: -1, prefix: comp(''), suffix: comp('!') },
    };
    const r = trip([original]);
    textRow(r, 'team', 'mode:update');
    same(r, original, { ignore: ['team'] });
});

test('team remove: only the team is named', () => {
    const original = { name: 'teams', params: { team: 'red', mode: 1 } };
    const r = trip([original]);
    textRow(r, 'team', 'mode:remove');
    same(r, original, { ignore: ['team'] });
});

test('team add_players and remove_players: the member names round trip', () => {
    const add = { name: 'teams', params: { team: 'red', mode: 3, players: ['Steve'] } };
    const rem = { name: 'teams', params: { team: 'red', mode: 4, players: ['Alex', 'Steve'] } };
    const r = trip([add]);
    textRow(r, 'team', 'mode:add_players');
    same(r, add, { ignore: ['team'] });
    const r2 = trip([rem]);
    textRow(r2, 'team', 'mode:remove_players');
    same(r2, rem, { ignore: ['team'] });
});

test('team with more than 16 members: the first 16 are sent (LOST past that)', () => {
    const names = Array.from({ length: 18 }, (_, i) => `Pl${String(i).padStart(2, '0')}`);
    const original = { name: 'teams', params: { team: 'big', mode: 3, players: names } };
    const r = trip([original], { names });
    const got = same(r, { ...original, params: { ...original.params, players: names.slice(0, 16) } }, { ignore: ['team'] });
    assert.equal(got.players.length, 16);
});

// ---- garbage ---------------------------------------------------------------------------------------------

test('team garbage: a member list on a remove is rejected and counted, not thrown', () => {
    const w = new Writer();
    const ctx = { playerId: 1, player: { x: 0, y: 64, z: 0 }, names: ['Steve'] };
    const out = w.step([{ io: 'out', tokens: ['TEXT', 'ch:team', 'mode:remove', 't0', 'np1', 'nm0'] }], ctx);
    assert.deepEqual(out, []);
    assert.equal(w.stats.rejected.size, 1);
});
