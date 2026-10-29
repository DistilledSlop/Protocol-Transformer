'use strict';

// The local inference server owns these client settings, independently of the recorded world.
const MODES = {
    survival: { id: 0, flags: 0 },
    creative: { id: 1, flags: 13 }, // invulnerable, may fly, instant build
    adventure: { id: 2, flags: 0 },
    spectator: { id: 3, flags: 7 }, // invulnerable, flying, may fly
};

function playerState(mode, level, playerId) {
    if (!Object.hasOwn(MODES, mode)) throw new Error(`invalid game mode ${mode}; expected ${Object.keys(MODES).join(', ')}`);
    if (!Number.isInteger(level) || level < 0 || level > 4) throw new Error('operator level must be an integer from 0 to 4');
    const { id, flags } = MODES[mode];
    return [
        { name: 'game_state_change', params: { reason: 'change_game_mode', gameMode: id } },
        { name: 'abilities', params: { flags, flyingSpeed: 0.05, walkingSpeed: 0.1 } },
        { name: 'entity_status', params: { entityId: playerId, entityStatus: 24 + level } },
        { name: 'camera', params: { cameraId: playerId } },
    ];
}

function isPlayerStatePacket(name, params, playerId) {
    return name === 'camera' || name === 'abilities' || (name === 'game_state_change' && params.reason === 'change_game_mode') ||
        (name === 'entity_status' && params.entityId === playerId && params.entityStatus >= 24 && params.entityStatus <= 28);
}

function parseGameModeCommand(command, username, level) {
    const words = command.trim().split(/\s+/);
    if (words[0].toLowerCase() !== 'gamemode') return null;
    if (level < 2) return { error: 'You do not have permission to use /gamemode.' };
    if (words.length < 2 || words.length > 3) return { error: 'Usage: /gamemode <survival|creative|adventure|spectator|0..3> [your username]' };
    const token = words[1].toLowerCase();
    const mode = ['survival', 'creative', 'adventure', 'spectator'][Number(token)] ?? token;
    if (!Object.hasOwn(MODES, mode) || (!Object.hasOwn(MODES, token) && !/^[0-3]$/.test(token))) return { error: 'Unknown game mode. Use survival, creative, adventure, spectator, or 0..3.' };
    if (words[2] && words[2].toLowerCase() !== username.toLowerCase()) return { error: 'You can only change your own game mode.' };
    return { mode };
}

// Preserve the capture's other command suggestions while exposing our local command.
function addGameModeCommand(tree, username) {
    const nodes = tree ? tree.nodes.map(n => ({ ...n, children: [...n.children] })) : [{ flags: { command_node_type: 0 }, children: [] }];
    const rootIndex = tree ? tree.rootIndex : 0;
    const root = nodes[rootIndex];
    root.children = root.children.filter(i => nodes[i]?.extraNodeData?.name !== 'gamemode');
    const literal = (name, children = [], executable = false) => ({ flags: { command_node_type: 1, has_command: executable ? 1 : 0 }, children, extraNodeData: { name } });
    const commandIndex = nodes.length;
    nodes.push(literal('gamemode'));
    root.children.push(commandIndex);
    for (const mode of [...Object.keys(MODES), '0', '1', '2', '3']) {
        const modeIndex = nodes.length;
        nodes.push(literal(mode, [modeIndex + 1], true), literal(username, [], true));
        nodes[commandIndex].children.push(modeIndex);
    }
    return { nodes, rootIndex };
}

module.exports = { playerState, isPlayerStatePacket, parseGameModeCommand, addGameModeCommand };
