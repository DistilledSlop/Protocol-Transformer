'use strict';
// Restore the actual player inventory as the same OUT SLOT SET rows used in captures.
// These seed model context only; they do not produce client packets or invent actions.
const { intTokens, floatToken } = require('../reader/tokens');

function inventorySnapshot(reader) {
    const slots = reader.S.windows.get(0) || [];
    return slots.flatMap((slot, i) => slot && slot.count > 0 ? [[
        'SLOT', 'SET', ...intTokens('w', 0), ...intTokens('i', i),
        `item:${slot.item}`, ...intTokens('n', slot.count), ...(slot.blob ? [`blob:${slot.blob}`] : []),
    ]] : []);
}
// Match the reader's periodic authoritative player context rows.
function playerContextSnapshot(reader) {
    const s = reader.S, rows = [];
    if (s.globals.gamemode !== undefined) rows.push(['GLOBAL', 'g:gamemode', ...intTokens('v', s.globals.gamemode)]);
    if (s.opLevel !== null) rows.push(['GLOBAL', 'g:op_level', ...intTokens('v', s.opLevel)]);
    if (s.abilities) rows.push(['GLOBAL', 'g:abilities', ...intTokens('v', s.abilities.flags), ...floatToken('fly', s.abilities.flyingSpeed), ...floatToken('walk', s.abilities.walkingSpeed)]);
    return rows;
}
module.exports = { inventorySnapshot, playerContextSnapshot };
