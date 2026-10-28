# reader

Turns a proxy capture (`<base>.bin` + `<base>.jsonl`) into the state table S and typed rows, as described in
the Protocol AI v3 design notes ("The token system", "Which packets make rows").

    node reader/roundtrip.js proxy/data/session_X            # encode(parse(bytes)) == bytes, every play packet
    node reader/read_session.js proxy/data/session_X \
        --text rows.txt --out rows.jsonl --vocab vocab.json   # stats, rows per tick, token counts
    node --test reader/test/*.test.js reader/test/families/*.test.js

Files: `capture.js` loads a session, `parse.js` wraps minecraft-protocol's codec, `phase.js` estimates the tick
phase (it differs per session: 4.2 ms and 48.0 ms in the first two captures), `quant.js` is the coarse/fine log
number tokenizer, `catalog.js` names block states, items and entity types, `reader.js` holds S and builds rows.

Packet coverage: `classification.tsv` (the 1.21.1 packet table) is joined to minecraft-protocol's names by
`gen_packets.js` into `packets.json`, and `node reader/coverage.js` lists, per tier, which play packets have a
handler (`--strict` exits 1 on any gap). Every MODEL, HYBRID, INPUT and INPUT_ACK packet has one. Packets in
the ENGINE, BAKED, DERIVED and DROP tiers make no row by design; `read_session.js` counts them separately from
packets that should have a handler and do not.

Rows: `io` is `in` (the client's input), `out` (a target for the model) or `eng` (derived from S by the engine,
for example range culling).

    ENTITY  SPAWN DESPAWN MOVE TP VEL META EQUIP PASSENGERS LINK INPUT
    BLOCK   (block change) ENTITY_DATA PLACE SIGN
    SLOT    SET CLOSE TRADE CLICK PICK RECIPE TRADE_SELECT HELD CREATIVE
    EVENT   SWING_* HURT DEATH DAMAGE STATUS CRIT.. ATTACK DIG USE_ITEM COMMAND CHAT SOUND PARTICLE EXPLOSION
            WORLD_EVENT BLOCK_ACTION DIG_STAGE EFFECT PICKUP COOLDOWN OPEN_* SYNC ...
    TEXT    chat actionbar title subtitle titletimes tab death bossbar objective score team
    GLOBAL  health food xp_bar xp_level rain thunder gamemode timeset timelock

The reader also emits engine conditioning rows for the actual player's mode and permissions:
`GLOBAL g:gamemode v0|v1|v2|v3` (Survival, Creative, Adventure, Spectator),
`GLOBAL g:abilities v<wire flags> fly:<float32 speed> walk:<float32 speed>`, and
`GLOBAL g:op_level v0..v4`. Login/respawn supply mode, server abilities supply flags and speeds,
and player entity statuses 24..28 supply permission level. Missing information stays unknown.
These snapshots wait for the first known player position and repeat every 40 ticks or on change,
so initial context survives dataset filtering and later context windows. They carry `io: 'eng'`
and no prediction loss. Engine mode snapshots compile to no packets; abilities and permission
rows never compile to packets even if produced by a model. Later observed `change_game_mode`
events retain their existing model output rows and packet compiler.

For protocol 767, `protocol767.js` corrects the pinned minecraft-data recipe serializer registry before
NMP compiles its codecs. The dependency retains obsolete `crafting_special_banneraddpattern` at ID 11;
Minecraft 1.21.1's own `RecipeSerializer` registration order instead has shield decoration at 11,
repair item at 14, smelting at 15, and decorated pots at 22. The stale entry shifts all later IDs and
misparses valid vanilla recipe payloads. This correction changes the decoder/encoder schema only;
recorded and forwarded frames remain untouched. Independent special/smelting wire fixtures test the
IDs, and the real pre-parser Creative-build capture roundtrips all 32,467 packets byte for byte,
including its 108,271-byte recipe packet (1,290 recipes).

Handlers live in `handlers/` by family (entity, world, inventory, text) and are mixed into `Reader`. Text is
never English tokens: strings become templates with numbers and player names cut out (`component.js`), and open
text the model only repeats is an opaque span.

Known approximations: the sound, particle and world-event catalogues are raw registry ids, not names; metadata
values for rare serializers fall back to a truncated JSON token; only the first seven chat-command arguments
get span tokens; the world store (chunks) is not read, only which chunks are loaded.

Reference data (`wiki/` and `statuses.json`, all generated from the wiki source dumps in the project root):
`wiki/parse_wiki.js` -> `wiki_packets.json` (field tables for all 224 packets), `wiki/compare.js` -> the field
comparison against minecraft-data, `wiki/parse_metadata.js` -> `wiki/entity_classes.json` (entity class tree,
metadata fields by index, entity name -> class) with `wiki/validate_metadata.js` checking it against the
captures, and `gen_statuses.js` -> `statuses.json` (entity status codes by class). The metadata page is for
Java 1.21.4, newer than the 1.21.1 target: against six captures it explains 99.8% of observed metadata entries;
the only misses are boats, which 1.21.4 splits by wood type. `object_data_reference.txt` is still a copy of the
protocol page, not the Object Data page.

## Writer (first slice)

`writer/` is the inverse path: rows (tokens) -> the packets a client needs.

    node reader/writer/eval_roundtrip.js proxy/data/session_X    # capture -> reader -> rows -> writer -> packets, with checks

- `writer/parse_rows.js` reads only tokens into intents with numbers in them (the compiler front end); a row it does
  not understand throws, so a bad row from the model is a counted rejection, not a guess.
- `writer/writer.js` keeps what the client believes (slot -> entity id, position, rotation; window state ids; health)
  and turns each tick's rows into packets: bundle-wrapped `spawn_entity`, `rel_entity_move` / `entity_move_look` /
  `entity_look` / `entity_head_rotation`, `entity_teleport`, `entity_velocity`, `entity_destroy`, `block_change` or a
  `multi_block_change` for two or more in one section, `set_slot`, animations, entity status, `damage_event`,
  `update_health`, `experience`, `game_state_change`. Entity ids and UUIDs are the engine's, not the model's.
- The evaluation checks that every emitted packet encodes and parses with minecraft-protocol, and that the writer's
  belief matches the reader's true scene each tick. On four captures (about 22,000 packets): no missing or extra
  entities; position error median 0.0005 blocks, at most 0.045 (the 1/16-block spawn grid); entities older than a
  second sit around 0.003.

Two reader rules make that work. A move row is the gap between the entity and what a client following the rows believes
(dequantized values included), so quantization error and dropped rows correct themselves; and the per-tick row cap only
drops moves, velocities, metadata and equipment (farthest first, retried next tick), never SPAWN, DESPAWN or TP.
Positions relative to the player (spawn, teleport, sounds, particles) are a whole-block offset plus a sixteenth, exact
at 1/16 block; only movement deltas and velocities use the coarse/fine log tokens.

Beyond the first slice, by family in `writer/families/`: `entityextra` (metadata, equipment, effects, passengers,
leashes, pickups), `worldevents` (sounds, particles, explosions, world events, block actions, dig stages, block
entity data, position syncs), `containers` (open, close, trades, cooldowns), `text` (chat, titles, tab header and
footer, death message, tab-list player info) and `scoreboard` (boss bars, objectives, scores, teams). Each is
checked by original packet -> reader -> writer -> rebuilt packet tests in `test/families/`. Item components and NBT
sit behind blob ids in the reader's blob store (`ctx.blobs`); player names are indexes into `ctx.names`.

Not compiled: world events beyond the 6-cell row range, and the
engine itself (login, configuration replay, acks, chunks). Lossy by design: text styling, particle data, trade
fields the tokens do not carry, health off the half-point grid, display names in the tab list. `onGround` is not in the rows; the writer guesses it from the vertical step. minecraft-protocol's encoder has
a bug for inline registry-entry holders (inline sounds, chat types, wolf and painting variants): it skips the marker
byte, so the writer must avoid or patch those.

## Live and replay (engine/)

    node engine/live_proxy.js --port 25570 --target 127.0.0.1:25565 --also blocks,slots,globals,text,events   # real server, scene rebuilt live
    node engine/live_proxy.js --port 25572 --pass-through                                                    # control
    node engine/replay_server.js proxy/data/session_X --port 25567 --mode raw                                # stand-in server: verbatim replay
    node engine/replay_server.js proxy/data/session_X --port 25568 --mode writer --also blocks,slots,globals,text,events

Result so far: a vanilla 1.21.1 client played a whole session through the live proxy with no errors, with the entity scene
(mobs, items, arrows, motion, metadata, equipment, attacks), blocks, slots and health/XP/weather all built by reader ->
writer instead of by the server; dropped items render. Not yet tried with a real client: the replay servers, which also
replace the server's login, configuration (Known Packs, registry data, tags) and chunks. The tab list, windows and the
player's own packets stay the server's in the live proxy. Writer-owned entities use ids from 10000; the proxy translates
them back when the client attacks or interacts.

## minecraft-protocol quirks that bite this project

- **Reader edits its input (Set Equipment).** `topBitSetTerminatedArray` clears the "more entries follow" bit of each slot byte
  in place while parsing, and a raw-forwarding proxy is handed that same buffer afterwards. Any multi-entry Set Equipment that
  passes through the library arrives damaged (first entry marked last) and the vanilla client kicks itself with "N bytes extra".
  Seen once at night on hard difficulty (armed mobs). New recorder captures tap uncompressed frames before the parser and retain the original bytes. For older captures and the
  live transformation proxy, `proxy/sanitize.js` repairs it before it is forwarded, `codec.parse` in `parse.js` reads such a packet as all its entries (so captures that
  contain it are fine), and `engine/schedule.js` repairs it for replays. `codec.parse` also parses a copy so callers' bytes are
  not edited.
- **Writer encoder, inline registry holders.** `registryEntryHolder` skips a byte without writing it in the inline branch (inline
  sounds, chat types, wolf and painting variants), so the writer refuses to encode those.

## Model server (engine/model_server.js)

A 1.21.1 server whose entity scene, blocks, slots and text come from the trained model. Login, configuration and the world come
from a capture's join packets (`engine/schedule.js`, mode `join`), with no chunk streaming, so the world ends at the edge of the
captured chunks. Every 50 ms tick the reader turns the client's packets into input rows; `train/infer.py serve` (a child process
speaking JSON lines) answers with rows; the writer compiles them to packets. The reader reads the writer's packets back with
`range: Infinity` and a `slotHint`, so slots stay the model's. Start it with `bash inference.sh` (port 25569 by default; `PORT`,
`CKPT`, `WORLD`, `ALSO` and `MODEL_ARGS` override). Join with the capture's username, `EmeraldIngot64`, in offline mode.
`--also` defaults to `blocks,slots,text,events`; `globals` (health, XP, weather) is opt-in, because a model that writes health 0
leaves the player on the death screen. `--max-backlog` (default 3) is how many ticks may wait for the model; past that, ticks are
only read and the model does not generate for them. The model does not yet beat an always-idle guess, so the scene is mostly noise.

## The world (reader/world.js, blockinfo.js)

The reader keeps the block state of every loaded chunk (`S.world`, decoded from Chunk Data and kept current by block updates;
checked against the server's own heightmaps, 76,800 of 76,800 columns). The model never sees terrain in its tokens, so the
reader gives it what it needs in four ways:

- `BLOCK ... NEAR` (engine row): the block and its six neighbors (`nb:` tokens) for every block that changed last tick and every
  block the player dug or placed, at most 6 a tick. `Reader({deferNear: false})` is for a live server whose changes are the model's
  own and arrive a tick late.
- `GLOBAL g:ground` (engine row): the height of the top solid block in 7x7 columns, 3 blocks apart, every 40 ticks or 4 blocks of
  walking. Taken at the end of the tick before, so it never shows a change the model is still to write.
- a terrain patch, not tokens: `Reader({terrain: true})` attaches the 13x13x13 block categories around the player (`blockinfo.category`,
  17 classes) to every fourth tick. `dataset.js export` writes them as `<session>.terrain.u8`, and the model's `TerrainEncoder` adds
  one vector per patch to each TICK token's embedding.
- leaf `distance` and `persistent` changes make no rows (`blockinfo.isInvisibleChange`): the client shows no difference. Every other
  block change, redstone included, is still a row.

On the way out, `writer/collide.js` stops a model-written MOVE at the first solid block (the writer gets `ctx.world` and `ctx.info`;
without them it does not clamp). `node --test reader/test/*.test.js reader/test/families/*.test.js` covers all of it.

## Augmentation (reader/augment.js, blockrot.js)

`dataset.js ... --augment 3` also exports each session with the world turned 90, 180 and 270 degrees (`<session>@r1..@r3`). A turn is
done on the parsed packets before the reader sees them: positions and velocities (x, z) -> (-z, x), block cells and chunks, yaw +90
degrees, block faces, and block states (`blockrot.js`: facing, axis, fence and wire connections, rotation, rail shapes), including the
chunk store itself. Rotation only, never mirroring, so left and right stay put. `node reader/augment_check.js <session>` compares an
original with its turned copies on things a turn must not change: how often the player moves the way they look (93.9% at every turn on
one session), standing on a solid block, placing against a block (96 of 96 at every turn), and every row count (identical). Not turned:
spatial values inside entity metadata, particle data, block entity NBT. Only training sessions are turned, never the held-out ones.

## The clock

Time passes by itself, so the model never predicts it; it only moves it. The engine owns a clock `{age, time, locked}` (the model
server seeds it from the join's Update Time), advances it every tick and sends Update Time once a second, as a vanilla server does.
The writer compiles `GLOBAL g:timeset v<0..99>` (time of day in 240-tick steps) and `GLOBAL g:timelock v0|v1` against `ctx.clock`
and sends the result at once; without a clock they are rejected. `engine/model_server.js --time cycle|keep|noon|midnight` (or `TIME=`
for `inference.sh`) sets the start: `cycle` lets the day run from morning, `keep` leaves the recorded time. In the captures 13 of 19
sessions start locked (negative time, a server with the day cycle off), and there are only 15 time rows in all of them.

For the model to change the time it needs three things, all in the rows now:
- it can read the command. Arguments used to be opaque copy tokens (`/time set noon` and `/time set midnight` were the same
  row); now numbers are their value (`v= d6 d0 d0 d0 ;`), keywords are `arg:<word>`, a number with a unit is both, and only free text is
  still a span.
- it can see the time: an engine row `GLOBAL g:clock <time of day in ticks> free|locked` every 40 ticks (taken a tick early, so a
  time set is never in it), and `GLOBAL g:timeset <ticks>` is the time of day exactly (it was 100 steps, and was not emitted at all
  while the day was locked).
- it has examples: `reader/synth.js` adds about 10 `/time set|add|query` commands per recording to the training sessions (never the
  held-out ones), with the clock change and the chat feedback a server would send, and shifts the real Update Time packets after
  them so the clock stays consistent (a real time jump in the recording drops the shift). That is some 700 commands and 500 time
  rows in the dataset where the recordings had 3 and 15.

The day cycle is the engine's; the model only makes one-off changes. `engine/model_server.js --engine-time` (`ENGINE_TIME=1` for
`inference.sh`) makes the engine answer `/time set|add|query` itself instead, for a model that has not learned to yet.

## Building the dataset (dataset.js build)

`bash preprocess.sh` runs `dataset.js build`: every session and every turned copy is tokenized once, in parallel (available CPUs minus two, limited by free memory),
into `dataset/.cache`; the vocabulary is counted from the cached token rows of the training sessions; then each is encoded with it. A
cached session is reused until its capture or any file under `reader/` (and `reader/dataset/`) changes, so adding a recording costs
that recording only. Output is byte-identical to the older `vocab` and `export` commands. The `--jobs N` option overrides the automatic worker count for both tokenization and encoding. The automatic budget reserves 30% of free memory and estimates each tokenization worker at 512 MiB plus four times the largest capture and index. Token and terrain writes are buffered in bounded batches; encoding streams cached rows in parallel while keeping manifest order deterministic. Each worker still loads its entire capture in memory, so choose a lower `--jobs` if other workloads need that memory. A changed vocabulary still requires all sessions to be encoded again.
