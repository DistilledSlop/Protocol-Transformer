'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { playerState, isPlayerStatePacket } = require('../player_state');
const { createCodec } = require('../../reader/parse');
const { makeReader, pkt, startPackets } = require('../../reader/test/helpers');

const codec = createCodec('1.21.1');
test('wire packets replace inconsistent captured state for every mode', () => {
    for (const [mode, id, flags] of [['survival', 0, 0], ['creative', 1, 13], ['adventure', 2, 0], ['spectator', 3, 7]]) {
        const reader = makeReader();
        reader.feedPacket(pkt(0, 'S2C', 'login', { entityId: 1, viewDistance: 10, worldState: { gamemode: 'spectator' } }));
        reader.feedPacket(startPackets()[1]);
        reader.feedPacket(pkt(2, 'S2C', 'abilities', { flags: 0, flyingSpeed: 0.05, walkingSpeed: 0.1 }));
        reader.flush();
        const state = playerState(mode, 4, 1);
        const camera = state.find(packet => packet.name === 'camera');
        assert.equal(codec.parse('S2C', codec.encode('S2C', camera.name, camera.params)).params.cameraId, 1);
        for (const packet of state) {
            const decoded = codec.parse('S2C', codec.encode('S2C', packet.name, packet.params));
            reader.feedPacket(pkt(3, 'S2C', decoded.name, decoded.params));
        }
        reader.flush();
        assert.equal(reader.S.globals.gamemode, id);
        assert.equal(reader.S.abilities.flags, flags);
        assert.equal(reader.S.opLevel, 4);
    }
});
test('model cannot overwrite local player state, but other events still pass', () => {
    assert.ok(isPlayerStatePacket('game_state_change', { reason: 'change_game_mode' }, 1));
    assert.ok(isPlayerStatePacket('abilities', {}, 1));
    assert.ok(isPlayerStatePacket('camera', { cameraId: 2 }, 1));
    assert.ok(isPlayerStatePacket('entity_status', { entityId: 1, entityStatus: 28 }, 1));
    assert.ok(!isPlayerStatePacket('entity_status', { entityId: 2, entityStatus: 28 }, 1));
    assert.ok(!isPlayerStatePacket('game_state_change', { reason: 'begin_raining' }, 1));
    assert.throws(() => playerState('invalid', 4, 1));
    assert.throws(() => playerState('creative', 5, 1));
});

test('gamemode command checks permission, target, mode and syntax', () => {
    const { parseGameModeCommand: parse } = require('../player_state');
    assert.deepEqual(parse('gamemode 3 Alice', 'Alice', 4), { mode: 'spectator' });
    assert.deepEqual(parse('gamemode creative', 'Alice', 2), { mode: 'creative' });
    assert.ok(parse('gamemode creative Bob', 'Alice', 4).error);
    assert.ok(parse('gamemode creative', 'Alice', 1).error);
    assert.ok(parse('gamemode 01', 'Alice', 4).error);
    assert.ok(parse('gamemode', 'Alice', 4).error);
    assert.equal(parse('time set day', 'Alice', 4), null);
});

test('gamemode command tree is encodable and preserves other commands', () => {
    const { addGameModeCommand } = require('../player_state');
    const node = (name, type, children = []) => ({ flags: { command_node_type: type }, children, ...(name ? { extraNodeData: { name } } : {}) });
    const tree = { rootIndex: 0, nodes: [node(null, 0, [1, 2]), node('time', 1), node('gamemode', 1)] };
    const updated = addGameModeCommand(tree, 'Alice');
    const decoded = codec.parse('S2C', codec.encode('S2C', 'declare_commands', updated)).params;
    assert.deepEqual(decoded.nodes[0].children.map(i => decoded.nodes[i].extraNodeData.name), ['time', 'gamemode']);
    const command = decoded.nodes[decoded.nodes[0].children[1]];
    assert.equal(command.children.length, 8);
    assert.equal(decoded.nodes[command.children[1]].extraNodeData.name, 'creative');
    assert.equal(tree.nodes[0].children.length, 2);
});
