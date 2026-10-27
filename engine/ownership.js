'use strict';
// Which server packets the writer owns when it replaces the entity scene (and, optionally, blocks, slots,
// globals). Shared by the replay schedule and the live proxy so both draw the line in the same place.

// the engine's own business, never replayed: the replay server runs its own keep-alive
const NEVER = new Set(['keep_alive', 'ping', 'ping_response', 'disconnect', 'start_configuration', 'transfer', 'cookie_request', 'store_cookie', 'compress']);

// packet families the writer produces
const FAMILIES = {
    scene: new Set(['spawn_entity', 'spawn_entity_experience_orb', 'entity_destroy', 'rel_entity_move', 'entity_move_look', 'entity_look', 'entity_head_rotation', 'entity_teleport', 'entity_velocity', 'bundle_delimiter', 'animation', 'damage_event', 'hurt_animation', 'entity_status', 'entity_metadata', 'entity_equipment', 'entity_effect', 'set_passengers', 'attach_entity', 'collect']),
    blocks: new Set(['block_change', 'multi_block_change']),
    slots: new Set(['set_slot']),
    globals: new Set(['update_health', 'experience', 'game_state_change']),
    // chat, titles, boss bars, scoreboard, teams. Not the tab list (player_info): it needs the real UUIDs and skins
    text: new Set(['system_chat', 'action_bar', 'profileless_chat', 'set_title_text', 'set_title_subtitle', 'set_title_time', 'clear_titles', 'playerlist_header', 'death_combat_event', 'boss_bar', 'scoreboard_objective', 'scoreboard_score', 'reset_score', 'scoreboard_display_objective', 'teams']),
    // sounds, particles, explosions, world events, block actions and dig stages. Not windows: the server owns window ids
    // the engine clock: the server's own Update Time. The model only moves it (a time set, a lock) with GLOBAL rows
    clock: new Set(['update_time']),
    events: new Set(['sound_effect', 'entity_sound_effect', 'stop_sound', 'world_particles', 'explosion', 'world_event', 'block_action', 'block_break_animation', 'tile_entity_data']),
};
// packets that name an entity the writer now owns the ids of: dropped unless they are about the player.
// `family` says which family has to be on for the writer to take them over (otherwise they are the server's).
const ENTITY_REF = {
    entity_metadata: { f: ['entityId'], family: 'scene' },
    entity_equipment: { f: ['entityId'], family: 'scene' },
    entity_update_attributes: { f: ['entityId'], family: 'scene' }, // derived by the engine: the writer sends none
    entity_effect: { f: ['entityId'], family: 'scene' },
    remove_entity_effect: { f: ['entityId'], family: 'scene' },
    set_passengers: { f: ['entityId'], family: 'scene' },
    attach_entity: { f: ['entityId'], family: 'scene' },
    collect: { f: ['collectedEntityId', 'collectorEntityId'], family: 'scene' },
    spawn_entity_experience_orb: { f: ['entityId'], family: 'scene' },
    open_horse_window: { f: ['entityId'], family: 'scene' }, // the horse is now a writer entity the server does not know
    entity_sound_effect: { f: ['entityId'], family: 'events' },
    block_break_animation: { f: ['entityId'], family: 'events' },
};
// weather and game mode are the writer's; the other game events (start waiting for chunks, respawn screen) are the engine's
const WRITER_GAME_EVENTS = new Set(['begin_raining', 'stop_raining', 'rain_level_change', 'thunder_level_change', 'change_game_mode']);

// families: a Set of family names in play (always includes 'scene'). Returns the names whose packets are owned.
const ownedNames = (families) => new Set([...families].flatMap((f) => [...FAMILIES[f]]));

// Should this server packet be dropped because the writer replaces it? parse() is only called when the
// decision needs the packet's fields, so most packets are decided by name alone.
function dropForWriter(name, owned, playerId, parse, families = new Set(['scene'])) {
    const ref = ENTITY_REF[name];
    if (ref && families.has(ref.family)) {
        const d = parse();
        return !ref.f.some((k) => d[k] === playerId);
    }
    if (!owned.has(name) || ref) return false;
    if (name === 'game_state_change') return WRITER_GAME_EVENTS.has(parse().reason);
    if (name === 'entity_status') {
        // the permission-level and debug-info statuses on the player are the engine's, the rest are rows
        const d = parse();
        return !(d.entityId === playerId && d.entityStatus >= 22 && d.entityStatus <= 28);
    }
    return true;
}

// Should this packet from the writer be sent? Only if its family is on, and not if it is about the player where the
// server's own packet was kept (metadata, equipment and effects of the player come from the server).
function writerOwns(name, params, families, playerId) {
    if (![...families].some((f) => FAMILIES[f].has(name))) return false;
    const ref = ENTITY_REF[name];
    return !(ref && families.has(ref.family) && ref.f.some((k) => params[k] === playerId));
}

module.exports = { NEVER, FAMILIES, ownedNames, dropForWriter, writerOwns };
