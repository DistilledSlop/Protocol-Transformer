'use strict';
// Everything the player reads: chat, titles, the action bar, boss bars, the scoreboard, teams and the
// tab list. Text is never English tokens: server strings become templates with the numbers and player
// names cut out, protocol names are catalogue entries, and chat the model only repeats is a span.

const { intTokens, bitTokens, clampStr } = require('../tokens');

const BOSS_ACTIONS = ['add', 'remove', 'health', 'title', 'style', 'flags'];
const TEAM_MODES = ['create', 'remove', 'update', 'add_players', 'remove_players'];

module.exports = {
    _textRow(io, channel, tokens, extra = {}) {
        return { row: 'TEXT', io, kind: channel, channel, tokens: ['TEXT', `ch:${channel}`, ...tokens], ...extra };
    },

    // Index of a named thing (objective, team, boss bar) in a table, assigned on first sight.
    _index(map, key) {
        let i = map.get(key);
        if (i === undefined) {
            i = map.size;
            map.set(key, i);
        }
        return i;
    },

    s2c_system_chat(d) {
        this._later(() => this._textRow('out', d.isActionBar ? 'actionbar' : 'chat', this._compTokens(d.content)));
    },

    s2c_action_bar(d) {
        this._later(() => this._textRow('out', 'actionbar', this._compTokens(d.text)));
    },

    // Disguised Chat Message: the preferred chat route, no signature.
    s2c_profileless_chat(d) {
        this._later(() => this._textRow('out', 'chatfrom', [...this._compTokens(d.name), 'msg', ...this._compTokens(d.message)]));
    },

    s2c_set_title_text(d) {
        this._later(() => this._textRow('out', 'title', this._compTokens(d.text)));
    },

    s2c_set_title_subtitle(d) {
        this._later(() => this._textRow('out', 'subtitle', this._compTokens(d.text)));
    },

    s2c_set_title_time(d) {
        this._later(() => this._textRow('out', 'titletimes', [...intTokens('in', d.fadeIn), ...intTokens('st', d.stay), ...intTokens('out', d.fadeOut)]));
    },

    s2c_clear_titles(d) {
        this._later(() => this._textRow('out', 'title', [d.reset ? 'reset' : 'clear']));
    },

    s2c_playerlist_header(d) {
        this._later(() => this._textRow('out', 'tab', ['header', ...this._compTokens(d.header), 'footer', ...this._compTokens(d.footer)]));
    },

    // Combat Death: the engine triggers the respawn screen; the model supplies the death message.
    s2c_death_combat_event(d) {
        this._later((ctx) => this._textRow('out', 'death', this._compTokens(d.message), { slot: ctx.slotOf(d.playerId) ?? undefined }));
    },

    s2c_boss_bar(d) {
        const bar = this._index(this.S.bars, d.entityUUID);
        const act = BOSS_ACTIONS[d.action] ?? `act${d.action}`;
        const tokens = [`act:${act}`, ...intTokens('b', bar)];
        if (d.action === 0 || d.action === 3) tokens.push(...this._compTokens(d.title));
        if (d.action === 0 || d.action === 2) tokens.push(...intTokens('h', Math.round(d.health * 64)));
        if (d.action === 0 || d.action === 4) tokens.push(...intTokens('col', d.color), ...intTokens('div', d.dividers));
        if (d.action === 0 || d.action === 5) tokens.push(...bitTokens(d.flags & 7, 3));
        if (d.action === 1) this.S.bars.delete(d.entityUUID);
        this._later(() => this._textRow('out', 'bossbar', tokens));
    },

    // Scoreboard objectives, scores and display slots.
    s2c_scoreboard_objective(d) {
        const o = this._index(this.S.objectives, d.name);
        const tokens = [`act:${['create', 'remove', 'update'][d.action] ?? d.action}`, ...intTokens('o', o)];
        if (d.displayText !== undefined) tokens.push(...this._compTokens(d.displayText));
        if (d.type !== undefined) tokens.push(...intTokens('ty', d.type));
        if (d.action === 1) this.S.objectives.delete(d.name);
        this._later(() => this._textRow('out', 'objective', tokens));
    },

    s2c_scoreboard_score(d) {
        const o = this._index(this.S.objectives, d.scoreName);
        const tokens = [...intTokens('o', o), this._nameTok(d.itemName), ...intTokens('v', d.value)];
        if (d.display_name !== undefined && d.display_name !== null) tokens.push(...this._compTokens(d.display_name));
        this._later(() => this._textRow('out', 'score', tokens));
    },

    s2c_reset_score(d) {
        const tokens = [this._nameTok(d.entity_name)];
        if (d.objective_name !== undefined && d.objective_name !== null) tokens.push(...intTokens('o', this._index(this.S.objectives, d.objective_name)));
        this._later(() => this._textRow('out', 'score', ['reset', ...tokens]));
    },

    s2c_scoreboard_display_objective(d) {
        const tokens = [...intTokens('pos', d.position), ...intTokens('o', this._index(this.S.objectives, d.name))];
        this._later(() => this._textRow('out', 'objective', ['display', ...tokens]));
    },

    s2c_teams(d) {
        const t = this._index(this.S.teams, d.team);
        const tokens = [`mode:${TEAM_MODES[d.mode] ?? d.mode}`, ...intTokens('t', t)];
        if (d.name !== undefined) tokens.push(...this._compTokens(d.name));
        if (d.friendlyFire !== undefined) tokens.push(...bitTokens(d.friendlyFire & 3, 2));
        if (d.nameTagVisibility !== undefined) tokens.push(`ntv:${d.nameTagVisibility}`, `col:${d.collisionRule}`);
        if (d.formatting !== undefined) tokens.push(...intTokens('fmt', d.formatting));
        if (d.prefix !== undefined) tokens.push('prefix', ...this._compTokens(d.prefix), 'suffix', ...this._compTokens(d.suffix));
        if (d.players !== undefined) tokens.push(...intTokens('np', d.players.length), ...d.players.slice(0, 16).map((p) => this._nameTok(p)));
        if (d.mode === 1) this.S.teams.delete(d.team);
        this._later(() => this._textRow('out', 'team', tokens));
    },

    // Player Info Update: the engine fills names and skins (baked); listed, latency, game mode and display
    // name are the model's. One row per player entry.
    s2c_player_info(d) {
        const a = d.action;
        for (const p of d.data) {
            let st = this.S.players.get(p.uuid);
            if (!st) this.S.players.set(p.uuid, (st = { idx: this.S.players.size }));
            if (p.player?.name) st.name = p.player.name;
            const tokens = [...intTokens('pl', st.idx)];
            if (a.add_player) tokens.push('add', p.player?.name ? this._nameTok(p.player.name) : 'nmUNKNOWN');
            if (a.update_game_mode) tokens.push(`gm${p.gamemode}`);
            if (a.update_listed) tokens.push(p.listed ? 'listed' : 'unlisted');
            if (a.update_latency) tokens.push(...intTokens('lat', Math.min(100, Math.round(p.latency / 10))));
            if (a.update_display_name) tokens.push(p.displayName ? this._compTokens(p.displayName)[0] : 'dn:none');
            this._later(() => this._textRow('out', 'tab', tokens));
        }
    },

    s2c_player_remove(d) {
        for (const u of d.players ?? []) this.S.players.delete(u);
    },

    // ---- serverbound chat -------------------------------------------------------------------------------
    // Commands become the command literal plus argument placeholders; the arguments the model must reuse are
    // spans. A chat message is open text the model only repeats, so a span plus a length bucket.
    // One argument of a typed command. A whole number is its value (`/time set 1000`), a number with a unit is the value and the
    // unit (`3d`), a keyword is itself (`set`, `noon`, `survival`), a known player is a name, and anything else is an opaque span
    // the model only copies. Turning keywords and numbers into tokens is what lets the model tell `/time set noon` from
    // `/time set midnight`; as spans they were all the same.
    _argTokens(a) {
        if (/^\d{1,9}$/.test(a)) return intTokens('v', Number(a));
        const unit = /^(\d{1,9})([tsd])$/.exec(a);
        if (unit) return [...intTokens('v', Number(unit[1])), `arg:${unit[2]}`];
        if (/^-?\d+(\.\d+)?$/.test(a)) return ['argnum'];
        if (this.S.nameIndex.has(a)) return [this._nameTok(a)];
        if (/^[a-z][a-z_:.]{0,23}$/.test(a)) return [`arg:${a}`];
        return [this._span(a)];
    },

    _command(cmd) {
        const parts = cmd.trim().split(/\s+/);
        const tokens = [`cmd:${clampStr(parts[0], 32)}`, ...intTokens('argc', parts.length - 1)];
        for (const a of parts.slice(1, 8)) tokens.push(...this._argTokens(a));
        return tokens;
    },

    c2s_chat_command(d) {
        this.T.events.push({ io: 'in', kind: 'COMMAND', entityId: this.S.playerId, tokens: this._command(d.command) });
    },

    c2s_chat_command_signed(d) {
        this.T.events.push({ io: 'in', kind: 'COMMAND', entityId: this.S.playerId, tokens: this._command(d.command) });
    },

    c2s_chat_message(d) {
        this.T.events.push({ io: 'in', kind: 'CHAT', entityId: this.S.playerId, tokens: [...intTokens('len', Math.min(255, d.message.length)), this._span(d.message)] });
    },
};
