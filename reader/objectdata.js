'use strict';
// The Data field of Spawn Entity (see object_data_reference.txt). Its meaning depends on the entity type.
// Owner ids are entity ids, so they become slots: the model sees who fired an arrow, not a raw id.

const { intTokens } = require('./tokens');

// Item frames and paintings: 0 down, 1 up, 2 north, 3 south, 4 west, 5 east. The client clamps invalid
// values with a modulus and uses the absolute value if negative.
const ORIENTED = new Set(['item_frame', 'glow_item_frame', 'painting']);

// Projectile-style entities whose Data is the owner's entity id (0 when there is none). The page names
// the class "Projectile" without listing members, and the wiki's entity tree has no such class, so the
// members are listed here from the vanilla projectile entity types.
const OWNED = new Set([
    'arrow', 'spectral_arrow', 'trident', 'snowball', 'egg', 'ender_pearl', 'potion', 'experience_bottle',
    'firework_rocket', 'fireball', 'small_fireball', 'dragon_fireball', 'wither_skull', 'wind_charge',
    'breeze_wind_charge', 'llama_spit', 'shulker_bullet', 'fishing_bobber', 'eye_of_ender',
]);

// -> tokens for the spawn row. slotOfId(entityId) gives the owner's slot or null.
function dataTokens(type, data, { blockState, slotOfId }) {
    if (ORIENTED.has(type)) return [`ori${Math.abs(data % 6)}`];
    if (type === 'falling_block') return [`blk:${blockState(data)}`];
    if (type === 'warden') return data === 1 ? ['emerging'] : [];
    if (OWNED.has(type)) {
        if (!data) return ['ownNONE'];
        const s = slotOfId(data);
        return [s === null ? 'ownUNKNOWN' : `own${s}`];
    }
    return [];
}

module.exports = { dataTokens, ORIENTED, OWNED, intTokens };
