'use strict';
// Builds a params object for one play packet from its protodef description, so the tests can feed every
// packet type to the Reader and not only the ones that appear in captures.
//
// synthesize(protocol, state, dir, name, mode):
//   protocol  the minecraft-data protocol object (protocol[state][dir].types holds the packet and its
//             named types; protocol.types holds the shared ones such as position and Slot)
//   dir       'toClient' or 'toServer'
//   mode      'min'  arrays empty, options absent, switches take their default (or first) case
//             'rich' arrays hold one element, options present, switches take the case that the
//                    sibling value selects, bitflags set their first flag, so the branches the Reader
//                    reads are exercised, not only the empty ones
//
// Values are checked by the caller by encoding and parsing them again (see packets.test.js); a packet whose
// value cannot be built is listed in UNSYNTHESIZABLE instead of being faked.

const UUID = '00000000-0000-0000-0000-000000000001';
// The entity the tests spawn before the synthesized packet (see packets.test.js).
const SCENE_ENTITY_ID = 7;
// Fields that name an entity: entityId, collectorEntityId, target, ...
const ENTITY_REF = /(^entityId$|EntityId$|^target$)/;
// Rich values for relative movement and rotation (1/4096 block, 1/256 turn units in the protocol).
const RICH_MOVE = { dX: 4096, dY: 4096, dZ: 4096, yaw: 64, pitch: 32, headYaw: 64 };

// A text component as nameless NBT, the form 1.21 uses for chat and item names.
const TEXT_NBT = { type: 'compound', name: '', value: { text: { type: 'string', value: 'hello 12' } } };

// Natives that have no useful zero value. Checked before the protocol definition is looked at.
const NATIVE_VALUES = {
    // Empty slot is a single count; a non-empty one needs its item id and component counts too, because
    // the Slot definition switches on itemCount.
    Slot: (mode) => (mode === 'min'
        ? { itemCount: 0 }
        : { itemCount: 1, itemId: 1, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] }),
    anonymousNbt: () => TEXT_NBT,
    // Optional NBT is absent when the tag is End.
    anonOptionalNbt: (mode) => (mode === 'min' ? { type: 'end' } : TEXT_NBT),
    compressedNbt: () => TEXT_NBT,
    UUID: () => UUID,
    restBuffer: () => Buffer.alloc(0),
};

// Zero values of the primitive types. i64/u64 are BigInt because the codec writes them with the BigInt
// methods of Buffer.
const PRIM_ZERO = {
    varint: 0, optvarint: 0, varlong: 0,
    i8: 0, u8: 0, i16: 0, u16: 0, i32: 0, u32: 0, i64: 0n, u64: 0n,
    f32: 0, f64: 0, bool: false,
    string: '', pstring: '', cstring: '',
    void: undefined,
};
const NUMERIC = new Set(['varint', 'optvarint', 'varlong', 'i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64']);

// A scope is one container's values so far, with the scope that holds it. Protodef paths such as
// '../action/add_player' start from the current scope; each '..' moves to the enclosing one.
function lookup(scope, path) {
    let s = scope;
    let v;
    let started = false;
    for (const part of path.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
            if (started || !s.parent) return undefined;
            s = s.parent;
            continue;
        }
        if (!started) {
            v = s.obj[part];
            started = true;
        } else {
            v = v == null ? undefined : v[part];
        }
    }
    return v;
}

// A count name a sibling array or buffer reads; these numeric fields must be 1 in rich mode, or the
// array would hold nothing while the count says otherwise.
function collectCounts(type, out) {
    if (!Array.isArray(type)) return;
    const [kind, opts] = type;
    if ((kind === 'array' || kind === 'buffer') && opts && typeof opts.count === 'string' && !opts.count.includes('/')) {
        out.add(opts.count);
    }
}

function arrayLength(opts, scope, ctx) {
    if (typeof opts.count === 'number') return opts.count;
    if (typeof opts.count === 'string') {
        const v = lookup(scope, opts.count);
        if (typeof v === 'number') return v;
        if (typeof v === 'bigint') return Number(v);
        throw new Error(`count ${opts.count} is not a number in scope`);
    }
    return ctx.mode === 'rich' ? 1 : 0; // countType: the count is written from the length
}

function genContainer(fields, parentScope, ctx) {
    const obj = {};
    const scope = { obj, parent: parentScope };
    const counted = new Set();
    for (const f of fields) collectCounts(f.type, counted);
    for (const f of fields) {
        if (f.anon) {
            // anon fields are flattened into the container, so their keys are the container's keys
            Object.assign(obj, gen(f.type, scope, ctx));
            continue;
        }
        if (counted.has(f.name) && typeof f.type === 'string' && NUMERIC.has(f.type)) {
            obj[f.name] = ctx.mode === 'rich' ? 1 : 0;
        } else if (ENTITY_REF.test(f.name) && typeof f.type === 'string' && NUMERIC.has(f.type)) {
            // Zero is the id of no entity; the tests spawn entity SCENE_ENTITY_ID, so entity packets aim at it.
            obj[f.name] = SCENE_ENTITY_ID;
        } else if (ctx.mode === 'rich' && f.name in RICH_MOVE && typeof f.type === 'string') {
            // A zero move, turn or head turn changes nothing, so no row could come from it; rich gives these
            // a real value so the handler's effect is exercised.
            obj[f.name] = RICH_MOVE[f.name];
        } else if (f.name === 'entityIds' && Array.isArray(f.type) && f.type[0] === 'array') {
            obj[f.name] = ctx.mode === 'rich' ? [SCENE_ENTITY_ID] : [];
        } else {
            obj[f.name] = gen(f.type, scope, ctx);
        }
    }
    return obj;
}

function genArray(elemDef, n, scope, ctx) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(gen(elemDef, scope, ctx));
    return out;
}

function genSwitch(opts, scope, ctx) {
    const fields = opts.fields || {};
    const keys = Object.keys(fields);
    const fallback = opts.default !== undefined ? opts.default : 'void';
    const value = lookup(scope, opts.compareTo);
    let chosen;
    if (value !== undefined) {
        // Only a value the sibling can actually hold selects a case; anything else gets the default.
        const k = String(value);
        chosen = Object.prototype.hasOwnProperty.call(fields, k) ? fields[k] : fallback;
    } else if (ctx.mode === 'rich' && keys.length) {
        // The sibling is not in scope, so there is no value to match; rich takes the first case.
        chosen = fields[keys[0]];
    } else {
        chosen = fallback === 'void' && keys.length ? fields[keys[0]] : fallback;
    }
    return gen(chosen, scope, ctx);
}

// Bit value of each flag, as the bitflags reader and writer use them.
function flagBits(flags) {
    if (Array.isArray(flags)) return Object.fromEntries(flags.map((name, i) => [name, 1 << i]));
    return flags; // shift and mask forms are resolved by the caller
}

function genBitflags(opts, ctx) {
    let bits;
    if (Array.isArray(opts.flags)) bits = flagBits(opts.flags);
    else if (opts.shift) bits = Object.fromEntries(Object.entries(opts.flags).map(([k, v]) => [k, 1 << v]));
    else bits = opts.flags;
    const out = {};
    let value = 0;
    const names = Object.keys(bits);
    names.forEach((name, i) => {
        const on = ctx.mode === 'rich' && i === 0;
        out[name] = on;
        if (on) value |= bits[name];
    });
    out._value = value;
    return out;
}

function gen(def, scope, ctx) {
    if (typeof def === 'string') return genNamed(def, scope, ctx);
    const [kind, opts] = def;
    switch (kind) {
        case 'container':
            return genContainer(opts, scope, ctx);
        case 'array':
            return genArray(opts.type, arrayLength(opts, scope, ctx), scope, ctx);
        case 'entityMetadataLoop':
            // Ends on a marker the codec writes itself, so zero entries is the empty loop.
            return genArray(opts.type, ctx.mode === 'rich' ? 1 : 0, scope, ctx);
        case 'topBitSetTerminatedArray':
            // The codec marks the last element by a high bit on it, so an empty array cannot be encoded
            // and parsed back; one element is the smallest valid value in both modes.
            return genArray(opts.type, 1, scope, ctx);
        case 'option':
            // def[1] is the inner type; the option is absent in min mode.
            return ctx.mode === 'rich' ? gen(opts, scope, ctx) : undefined;
        case 'switch':
            return genSwitch(opts, scope, ctx);
        case 'bitfield': {
            const out = {};
            for (const f of opts) out[f.name] = 0;
            return out;
        }
        case 'bitflags':
            return genBitflags(opts, ctx);
        case 'mapper':
            // The value is the name a mapping gives, the codec maps it back to the number.
            return opts.mappings[Object.keys(opts.mappings)[0]];
        case 'buffer': {
            if (typeof opts.count === 'number') return Buffer.alloc(opts.count);
            if (typeof opts.count === 'string') return Buffer.alloc(arrayLength(opts, scope, ctx));
            return Buffer.alloc(0); // countType: a zero-length buffer
        }
        case 'pstring':
            return '';
        case 'registryEntryHolder':
            // Both modes use the registry id. The inline branch is not written: the codec's writer for it
            // skips the 0 marker byte (minecraft-protocol compiler-minecraft, registryEntryHolder), so the
            // encoded bytes are whatever the buffer held, and the parsed value is then random.
            return { [opts.baseName]: ctx.mode === 'rich' ? 1 : 0 };
        case 'registryEntryHolderSet':
            return ctx.mode === 'rich'
                ? { [opts.otherwise.name]: [gen(opts.otherwise.type, scope, ctx)] }
                : { [opts.base.name]: gen(opts.base.type, scope, ctx) };
        default:
            throw new Error(`no synthesizer for protodef type ${kind}`);
    }
}

function genNamed(name, scope, ctx) {
    if (Object.prototype.hasOwnProperty.call(NATIVE_VALUES, name)) return NATIVE_VALUES[name](ctx.mode);
    const def = ctx.types[name] || ctx.protocol.types[name];
    if (def === undefined) throw new Error(`unknown protodef type ${name}`);
    if (def === 'native') {
        if (!Object.prototype.hasOwnProperty.call(PRIM_ZERO, name)) throw new Error(`no value for native type ${name}`);
        return PRIM_ZERO[name];
    }
    return gen(def, scope, ctx);
}

function synthesize(protocol, state, dir, name, mode) {
    if (mode !== 'min' && mode !== 'rich') throw new Error(`mode must be min or rich, not ${mode}`);
    const types = protocol[state][dir].types;
    // Play packets shared with configuration are defined once in the root types as packet_common_<name>.
    const def = types[`packet_${name}`] || protocol.types[`packet_common_${name}`];
    if (def === undefined) {
        // A packet with no fields has no type of its own; the id mapping names it, so it is empty.
        if (JSON.stringify(types.packet || {}).includes(`"${name}"`)) return {};
        throw new Error(`no packet_${name} in ${state} ${dir}`);
    }
    return gen(def, null, { mode, protocol, types });
}

// 'S2C name' or 'C2S name' -> reason a value cannot be built for it, for both modes; 'S2C name rich' limits
// the entry to one mode. Filled in by running the synthesizer through the codec. A packet listed here is
// reported and skipped by the tests, never faked.
const UNSYNTHESIZABLE = {};

module.exports = { synthesize, UNSYNTHESIZABLE, UUID };
