'use strict';

// Minecraft 1.21.1 RecipeSerializer's registration order has no banner-add-pattern
// serializer. The pinned minecraft-data table retains that removed entry at 11,
// shifting shield decoration through decorated pots. Correct the schema before
// NMP compiles/caches it; raw packet bytes are never edited.
function correctRecipeSerializers(data) {
    if (data.version.version !== 767) return false;
    const packet = data.protocol.play.toClient.types.packet_declare_recipes;
    const fields = packet[1][0].type[1].type[1];
    const mappings = fields.find(field => field.name === 'type').type[1].mappings;
    if (mappings[11] !== 'minecraft:crafting_special_banneraddpattern') return false;
    if (mappings[23] !== 'minecraft:crafting_decorated_pot') throw new Error('Unexpected protocol767 recipe serializer table');
    for (let id = 11; id < 23; id++) mappings[id] = mappings[id + 1];
    delete mappings[23];
    return true;
}

module.exports = { correctRecipeSerializers };
