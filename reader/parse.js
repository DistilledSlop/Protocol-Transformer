'use strict';
// Packet bytes <-> objects, using minecraft-protocol's serializers for the capture's version.
// Raw buffers in a capture are packet id + body with no length prefix, which is what the
// serializer produces, so encode(parse(bytes)) can be compared with the original bytes.

const { mc } = require('./deps');

function createCodec(version = '1.21.1', state = 'play') {
    // The deserializer for packets the server sends is the client-side one (isServer false).
    const make = (isServer) => ({
        de: mc.createDeserializer({ state, isServer, version, noErrorLogging: true }),
        se: mc.createSerializer({ state, isServer: !isServer, version }),
    });
    const s2c = make(false);
    const c2s = make(true);
    const pick = (dir) => (dir === 'S2C' ? s2c : c2s);

    const varintLen = (b, off) => {
        let n = 1;
        while (b[off + n - 1] & 0x80) n++;
        return n;
    };

    // minecraft-protocol's reader clears the "more entries follow" bit of a Set Equipment slot byte IN PLACE while it parses,
    // and a raw-forwarding proxy is handed that same buffer afterwards. So any packet that went through the library with two
    // or more equipment entries arrives (and is recorded) with the first entry marked as the last, and the vanilla client
    // rejects it with "N bytes extra". The entries are all still there, so read them one after another.
    function readEquipment(parser, buf, first) {
        const entries = [...first.data.params.equipments];
        const headerLen = varintLen(buf, 0) + varintLen(buf, varintLen(buf, 0)); // packet id, entity id
        const header = buf.subarray(0, headerLen);
        let used = first.metadata.size;
        for (let guard = 0; used < buf.length && guard < 8; guard++) {
            const next = parser.parsePacketBuffer(Buffer.concat([header, buf.subarray(used)]));
            entries.push(...next.data.params.equipments);
            used += next.metadata.size - headerLen;
        }
        return { entries, complete: used === buf.length };
    }

    function parseFull(dir, buf) {
        const parser = pick(dir).de;
        // parse a copy of small packets: the library's reader edits the bytes it reads (see above), and the caller's bytes
        // should stay as they were
        const r = parser.parsePacketBuffer(buf.length <= 4096 ? Buffer.from(buf) : buf);
        const out = { name: r.data.name, params: r.data.params, repaired: false };
        if (dir === 'S2C' && out.name === 'entity_equipment' && r.metadata.size < buf.length) {
            const { entries, complete } = readEquipment(parser, buf, r);
            if (complete) {
                out.params = { ...out.params, equipments: entries };
                out.repaired = true;
            }
        }
        return out;
    }

    return {
        parse(dir, buf) {
            const { name, params, repaired } = parseFull(dir, buf);
            return { name, params, repaired };
        },
        encode(dir, name, params) {
            return pick(dir).se.createPacketBuffer({ name, params });
        },
        // The bytes to forward to a client: the packet as it is, or rebuilt if it was malformed in a way we can fix.
        // Returns null when nothing needs fixing.
        fix(dir, buf) {
            const r = parseFull(dir, buf);
            return r.repaired ? pick(dir).se.createPacketBuffer({ name: r.name, params: r.params }) : null;
        },
    };
}

module.exports = { createCodec };
