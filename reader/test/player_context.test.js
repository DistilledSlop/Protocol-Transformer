'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeReader, pkt, run, startPackets } = require('./helpers');
const { Writer } = require('../writer/writer');

const contextRows = (ticks, field) => ticks.flatMap(t => t.rows).filter(r => r.io === 'eng' && r.field === field);
const login = mode => pkt(0, 'S2C', 'login', { entityId: 1, viewDistance: 10, worldState: { gamemode: mode } });
const abilities = flags => pkt(2, 'S2C', 'abilities', { flags, flyingSpeed: 0.05, walkingSpeed: 0.1 });
const permission = level => pkt(3, 'S2C', 'entity_status', { entityId: 1, entityStatus: 24 + level });
const ctx = { playerId: 1, player: { x: 0, y: 64, z: 0 } };

test('all four initial game modes condition the model with existing numeric encoding', () => {
    for (const [number, mode] of ['survival', 'creative', 'adventure', 'spectator'].entries()) {
        const ticks = run(makeReader(), [login(mode), startPackets()[1]]);
        assert.deepEqual(contextRows(ticks, 'gamemode').map(r => r.tokens), [['GLOBAL', 'g:gamemode', `v${number}`]]);
        assert.equal(ticks.flatMap(t => t.rows).filter(r => r.io === 'out' && r.field === 'gamemode').length, 0);
        assert.deepEqual(new Writer().step(contextRows(ticks, 'gamemode'), ctx), []);
    }
});

test('server abilities and actual permission status distinguish Survival nonOP and Creative OP contexts', () => {
    const tokens = (mode, flags, level) => {
        const ticks = run(makeReader(), [login(mode), startPackets()[1], abilities(flags), permission(level)]);
        return ['abilities', 'op_level'].map(field => contextRows(ticks, field)[0].tokens);
    };
    const survival = tokens('survival', 0, 0);
    const creative = tokens('creative', 15, 2);
    assert.equal(survival[0][2], 'v0');
    assert.equal(creative[0][2], 'v15');
    assert.deepEqual(survival[1], ['GLOBAL', 'g:op_level', 'v0']);
    assert.deepEqual(creative[1], ['GLOBAL', 'g:op_level', 'v2']);
    assert.notDeepEqual(survival, creative);
});

test('unknown permission stays unknown; other entity status cannot grant player context', () => {
    const ticks = run(makeReader(), [login('survival'), startPackets()[1],
        pkt(3, 'S2C', 'entity_status', { entityId: 99, entityStatus: 28 })]);
    assert.deepEqual(contextRows(ticks, 'op_level'), []);
});

test('initial context survives ticks before position and repeats within later windows', () => {
    const reader = makeReader();
    const ticks = run(reader, [login('creative'), abilities(15), permission(2),
        pkt(101, 'S2C', 'keep_alive', { keepAliveId: 1n }),
        { ...startPackets()[1], t: 151 }, pkt(2201, 'S2C', 'keep_alive', { keepAliveId: 2n })]);
    const rows = contextRows(ticks, 'gamemode');
    assert.ok(rows.length >= 2);
    assert.ok(ticks.filter(t => t.rows.some(r => r.field === 'gamemode')).every(t => t.player.known));
});

test('later mode changes remain model outputs, and become context only on the following tick', () => {
    const ticks = run(makeReader(), [login('survival'), startPackets()[1],
        pkt(51, 'S2C', 'game_state_change', { reason: 'change_game_mode', gameMode: 1 }),
        pkt(101, 'S2C', 'keep_alive', { keepAliveId: 1n })]);
    const outputs = ticks.flatMap(t => t.rows).filter(r => r.io === 'out' && r.field === 'gamemode');
    assert.equal(outputs.length, 1);
    assert.deepEqual(new Writer().step(outputs, ctx), [{ name: 'game_state_change', params: { reason: 'change_game_mode', gameMode: 1 } }]);
    const snapshots = contextRows(ticks, 'gamemode');
    assert.deepEqual(snapshots.map(r => r.tokens[2]), ['v0', 'v1']);
});

test('respawn observes a new mode; forged ability and permission rows never make packets', () => {
    const ticks = run(makeReader(), [login('survival'), startPackets()[1],
        pkt(51, 'S2C', 'respawn', { worldState: { gamemode: 'spectator' } })]);
    assert.deepEqual(contextRows(ticks, 'gamemode').map(r => r.tokens[2]), ['v0', 'v3']);
    const writer = new Writer();
    assert.deepEqual(writer.step([
        { io: 'out', tokens: ['GLOBAL', 'g:op_level', 'v4'] },
        { io: 'out', tokens: ['GLOBAL', 'g:abilities', 'v15', 'fly:1', 'walk:1'] },
    ], ctx), []);
    assert.equal(writer.stats.rejected.size, 0);
});
