'use strict';
// Capture complete decompressed frames before minecraft-protocol parses, bundles, or mutates them.
// The library's public `raw` event is post-parser and therefore cannot preserve parser failures.
const minecraftData = require('minecraft-data');
const tables = new Map();

function packetMetadata(buffer, state, isServer, version) {
    let table = tables.get(version);
    if (!table) {
        const data = minecraftData(version);
        if (!data || data.version.version !== 767) throw new Error('Wire recorder requires protocol 767');
        table = new Map();
        for (const [phase, directions] of Object.entries(data.protocol)) {
            if (!directions || typeof directions !== 'object') continue;
            for (const direction of ['toClient', 'toServer']) {
                const field = directions[direction]?.types?.packet?.[1]?.find((part) => part.name === 'name');
                const mappings = field?.type?.[0] === 'mapper' ? field.type[1].mappings : null;
                if (mappings) table.set(phase + '/' + direction,
                    new Map(Object.entries(mappings).map(([id, name]) => [Number(id), name])));
            }
        }
        tables.set(version, table);
    }
    let id = 0, complete = false;
    for (let index = 0; index < Math.min(5, buffer.length); index++) {
        id += (buffer[index] & 0x7f) * 2 ** (7 * index);
        if (!(buffer[index] & 0x80)) { complete = true; break; }
    }
    const names = table.get(state + '/' + (isServer ? 'toServer' : 'toClient'));
    return { state, name: complete ? names?.get(id) || `unknown_packet_${id}` : 'invalid_packet_id',
        id: complete ? id : null, wire: true, wireIdValid: complete };
}

function installWireTap(client, onFrame, { onError = (error) => client.emit('error', error) } = {}) {
    let source = null;
    let closed = false;
    const originalCompression = client.setCompressionThreshold;
    const receive = (frame) => {
        if (closed) return;
        try {
            // Both recording and forwarding own bytes that later parser callbacks cannot edit.
            const copy = Buffer.from(frame);
            const meta = packetMetadata(copy, client.state, client.isServer, client.version);
            onFrame(copy, meta);
        } catch (error) { onError(error); }
    };
    const refresh = () => {
        if (closed) return;
        const active = client.decompressor || client.splitter;
        if (!active || typeof active.prependListener !== 'function') throw new Error('Unsupported minecraft-protocol frame pipeline');
        if (active === source) return;
        source?.removeListener('data', receive);
        source = active;
        // pipe() registered the parser's data listener first. Prepending is essential to see original bytes.
        source.prependListener('data', receive);
    };
    const setCompression = function (...args) {
        const result = originalCompression.apply(this, args);
        refresh();
        return result;
    };
    client.setCompressionThreshold = setCompression;
    client.on('state', refresh);
    refresh();
    return () => {
        if (closed) return;
        closed = true;
        source?.removeListener('data', receive);
        client.removeListener('state', refresh);
        if (client.setCompressionThreshold === setCompression) client.setCompressionThreshold = originalCompression;
    };
}
module.exports = { installWireTap, packetMetadata };
