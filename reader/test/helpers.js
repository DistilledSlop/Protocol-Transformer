'use strict';
// Builders for in-memory packets. Nothing here reads a capture file or opens a connection.

const { Reader } = require('../reader');

const UUID = '00000000-0000-0000-0000-000000000001';
const NO_FLAGS = { x: false, y: false, z: false, yaw: false, pitch: false };

const makeReader = () => new Reader({ phase: 0 });

const pkt = (t, dir, name, params) => ({ t, dir, name, params });

// Feed packets in order, collect every closed tick, then close the open one.
// Returns one flat array of {tick, rows}.
function run(reader, packets) {
    const ticks = [];
    for (const p of packets) ticks.push(...reader.feedPacket(p));
    ticks.push(...reader.flush());
    return ticks;
}

// The two packets every scenario starts with: the player exists, then is placed at the origin.
function startPackets() {
    return [
        pkt(0, 'S2C', 'login', { entityId: 1, viewDistance: 10 }),
        pkt(1, 'S2C', 'position', { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, flags: NO_FLAGS, teleportId: 1 }),
    ];
}

function spawnPkt(t, entityId, x, y, z, extra = {}) {
    return pkt(t, 'S2C', 'spawn_entity', {
        entityId,
        objectUUID: UUID,
        type: 77,
        x,
        y,
        z,
        pitch: 0,
        yaw: 0,
        headPitch: 0,
        objectData: 0,
        velocity: { x: 0, y: 0, z: 0 },
        ...extra,
    });
}

// Rows of one tick number (ticks may be split across several returned objects).
function rowsAt(ticks, tick) {
    return ticks.filter((t) => t.tick === tick).flatMap((t) => t.rows);
}

// ENTITY rows about one entity id.
function entityRows(rows, entityId) {
    return rows.filter((r) => r.row === 'ENTITY' && r.entityId === entityId);
}

module.exports = { UUID, NO_FLAGS, makeReader, pkt, run, startPackets, spawnPkt, rowsAt, entityRows };
