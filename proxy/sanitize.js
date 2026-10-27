'use strict';
// Packets that reach a raw-forwarding proxy damaged, repaired before they go on to the client. Today that is one case:
// minecraft-protocol's reader clears a bit of every multi-entry Set Equipment in place while parsing (see reader/parse.js),
// so the client would kick itself on the first mob that spawns with gear in two or more slots. The recorder stores the bytes
// as the library left them; the reader repairs the same damage when it reads a capture back.

const path = require('path');
let codec = null;

// buf: a server play packet as received. Returns the bytes to forward, or the same buffer if nothing needed fixing.
// `counts` (a Map) is bumped for each repair so the caller can report them.
function forServer(name, buf, counts) {
    if (name !== 'entity_equipment') return buf; // only decide by name, the parse costs nothing for the rest
    try {
        codec ??= require(path.join(__dirname, '..', 'reader', 'parse')).createCodec('1.21.1');
        const fixed = codec.fix('S2C', buf);
        if (fixed) {
            counts?.set(name, (counts.get(name) || 0) + 1);
            return fixed;
        }
    } catch (e) {
        // an unparseable packet is forwarded untouched, as before
    }
    return buf;
}

module.exports = { forServer };
