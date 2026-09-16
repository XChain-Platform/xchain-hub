/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - query methods for the config oracle table.
 *
 * Owns src/sql/configs.sql, which carries both the served config tree and the
 * hub's own node-local observations (chain tips, the admission watermark floor).
 * src/db/index.js installs every method below on Database.prototype, so callers
 * keep writing db.<method>() and never see which file the query lives in.
 *
 * Add a query as one more object-literal method before the closing brace: one
 * statement per method, ? placeholders, and a get/find/create/update/set/delete/
 * is/has verb prefix naming the table family it reads.
 *
 ********************************************************************/

// The `coin` key the admission watermark floor is stored under. The watermark is
// per (table, chain) and the hub federates every chain, so it has no coin of its
// own: the same problem getConfigRowsByModule exists for, solved here with one
// reserved key so the read stays a plain getConfig.
const ADMISSION_WATERMARK_COIN = 'xchain';

// Canonical coin names. The hub config tree keys coins by full name
// (bitcoin/litecoin/dogecoin); indexers, however, push chain tips using the
// coin abbreviation (config['COIN'] = 'BTC'/'LTC'/'DOGE'). Storing chain_tips
// under the abbreviation creates a phantom top-level coin key (e.g. 'BTC')
// alongside the real 'bitcoin' entry, which the explorer's config loader
// cannot map to a coin and crashes on (configs/undefined.js). Normalize
// the coin to its full name so chain_tips co-locate under the canonical key.
const coins = require('../coins');
const COIN_FULL_NAME = { ...coins.COIN_FULL_NAME };

function normalizeCoin(coin) {
    if (typeof coin !== 'string') return coin;
    return COIN_FULL_NAME[coin.toUpperCase()] || coin;
}

module.exports = {

    async setParam(coin, network, module, paramName, paramValue){
        let query = `INSERT INTO configs (coin, network, module, param_name, param_value)
                     VALUES (?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE param_value = ?, updated_at = NOW()`;
        await this.doQuery(query, [coin, network, module, paramName, paramValue, paramValue]);
    },

    // Batched upsert. rows: [{coin, network, module, paramName, paramValue}, ...]
    // Single round-trip: keeps xchain-node's precheck push (3 coins x 3 networks
    // x ~6 modules x ~7 params ~= 378 rows) under one second instead of one
    // INSERT per row.
    async setParams(rows){
        if(!rows || rows.length === 0) return 0;
        let placeholders = rows.map(() => '(?, ?, ?, ?, ?)').join(', ');
        let query = `INSERT INTO configs (coin, network, module, param_name, param_value)
                     VALUES ${placeholders}
                     ON DUPLICATE KEY UPDATE param_value = VALUES(param_value), updated_at = NOW()`;
        let args = [];
        for(let r of rows){
            args.push(r.coin, r.network, r.module, r.paramName, r.paramValue);
        }
        await this.doQuery(query, args);
        return rows.length;
    },

    // The admission height watermark's durable FLOOR.
    //
    // The watermark is a CLAIM about rounds, and a claim that was sound when it was
    // published stays sound: a round that had terminated before this hub restarted has not
    // un-terminated. Without a floor every hub restart publishes no heights for one full
    // round-abandon window while every indexer on every re-keyed barrier defers, which is a
    // mirror outage per restart rather than a design property.
    //
    // Stored in `configs` beside chain_tips because it is exactly that kind of value: the
    // hub's own observation of a chain, node-local, hashed by nothing. It is a floor and
    // never a ceiling; the producer takes the max of it and what this hub can justify from
    // its own tip observations, and a per-rail cap still pulls the result down.
    //
    // `coin` is the chain-agnostic 'xchain' key, as the hub has no coin of its own: the
    // identity of a row is the (table, chain) pair in its param_name.
    async getAdmissionWatermarkFloor(network){
        let net  = network || 'mainnet';
        let rows = await this.getConfig(ADMISSION_WATERMARK_COIN, net, 'admission_watermark');
        let out  = {};
        for(let name of Object.keys(rows || {})){
            // '<table>.<chain>'. Table names and chain codes both exclude '.', so the first
            // dot is the only split, and anything else is skipped rather than guessed at.
            let dot = String(name).indexOf('.');
            if(dot <= 0 || dot === String(name).length - 1) continue;
            let table = String(name).slice(0, dot);
            let chain = String(name).slice(dot + 1);
            let raw   = String(rows[name]);
            if(!/^(?:0|[1-9][0-9]*)$/.test(raw)) continue;
            let h = Number(raw);
            if(!Number.isSafeInteger(h)) continue;
            if(!out[table]) out[table] = {};
            out[table][chain] = h;
        }
        return out;
    },

    // Persist the floor, monotonically and only where it moved.
    //
    // Monotonic because a floor that retreated would re-open the restart window it exists
    // to close, and only-where-it-moved because the producer samples on a timer: writing
    // every entry every pass would be one configs UPDATE per table per chain per sample
    // for a value that changes once per block.
    //
    // Returns how many rows were written, so a caller can see the floor moving.
    async saveAdmissionWatermarkFloor(network, heights){
        let net = network || 'mainnet';
        if(!this._admissionFloorWritten) this._admissionFloorWritten = new Map();
        let rows = [];
        let mark = [];
        for(let table of Object.keys(heights || {})){
            let inner = heights[table];
            if(!inner || typeof inner !== 'object') continue;
            for(let chain of Object.keys(inner)){
                let h = Number(inner[chain]);
                if(!Number.isSafeInteger(h) || h < 0) continue;
                let key  = net + '|' + table + '|' + chain;
                let prev = this._admissionFloorWritten.has(key) ? this._admissionFloorWritten.get(key) : null;
                if(prev !== null && h <= prev) continue;
                rows.push({ coin: ADMISSION_WATERMARK_COIN, network: net, module: 'admission_watermark',
                            paramName: table + '.' + chain, paramValue: String(h) });
                mark.push([key, h]);
            }
        }
        if(rows.length === 0) return 0;
        let written = await this.setParams(rows);
        // Marked only AFTER the write landed: caching a value the INSERT threw on would skip
        // it on every later pass and leave the floor permanently behind.
        for(let [key, h] of mark) this._admissionFloorWritten.set(key, h);
        return written;
    },

    async getConfig(coin, network, module){
        let query = "SELECT param_name, param_value FROM configs WHERE coin = ? AND network = ? AND module = ?";
        let rows  = await this.doQuery(query, [coin, network, module]);
        let config = {};
        for(let row of rows){
            config[row.param_name] = row.param_value;
        }
        return config;
    },

    // Every row of one module on one network, across coins, ordered so two hubs
    // reading the same table see the same sequence. getConfig() above needs a coin,
    // and a hub has none: it federates several chains and p2pConfig carries only
    // HUB_NETWORK. Used for chain-agnostic modules whose param_name is the whole
    // identity (ATTESTATION_PROVIDER rows are one definition per provider_id), where
    // a coin-keyed read would have to invent a coin to ask for.
    async getConfigRowsByModule(network, module){
        let query = "SELECT coin, param_name, param_value FROM configs WHERE network = ? AND module = ? "
                  + "ORDER BY coin, param_name";
        return await this.doQuery(query, [network, module]);
    },

    // Network defaults to 'mainnet' for back-compat with older indexers.
    //
    // `chainId` (optional) identifies the chain INSTANCE the pushing indexer follows:
    // the hash of its block 1, not of block 0, because the regtest genesis hash is a
    // chainparams constant that survives every re-genesis while block 1 commits to the
    // moment the new chain started. Omitted (older indexer, or a chain whose block 1 is
    // not mined yet) leaves the stored value alone rather than clearing it, so a single
    // push that has not learned the id cannot erase an identity the mirrors are filtering on.
    async setChainTip(coin, network, blockHeight, blockTime, chainId){
        let net = network || 'mainnet';
        // Store under the full coin name (see COIN_FULL_NAME) so chain_tips never
        // appears as an abbreviation-keyed phantom coin in the served config tree.
        let key = normalizeCoin(coin);
        await this.setParam(key, net, 'chain_tips', 'block_height', String(blockHeight));
        await this.setParam(key, net, 'chain_tips', 'block_time',   String(blockTime));
        if(typeof chainId === 'string' && chainId)
            await this.setParam(key, net, 'chain_tips', 'chain_id', chainId);
    },

    // Network defaults to 'mainnet' for back-compat; multi-network hubs must pass it explicitly.
    // Returns: { blockHeight, blockTime, chainId } or null if not set.
    async getChainTip(coin, network){
        let net = network || 'mainnet';
        // Prefer the canonical full-name key (setChainTip writes there now). Fall
        // back to the raw abbreviation for tips written before the normalization,
        // so a deploy never opens a read gap on the oracle's BTC anchor.
        let cfg = await this.getConfig(normalizeCoin(coin), net, 'chain_tips');
        if(!cfg.block_height && normalizeCoin(coin) !== coin)
            cfg = await this.getConfig(coin, net, 'chain_tips');
        if(!cfg.block_height) return null;
        return {
            blockHeight: parseInt(cfg.block_height),
            blockTime:   parseInt(cfg.block_time) || 0,
            // Explicitly null, never undefined, when no indexer has reported one: every
            // consumer (the row stamps, the snapshot envelopes) treats null as "identity
            // unknown", which the mirrors accept, so a hub that has not learned its chain
            // keeps behaving exactly as it did before the column existed.
            chainId:     (typeof cfg.chain_id === 'string' && cfg.chain_id) ? cfg.chain_id : null
        };
    },

    // Returns: { coin: { network: { module: { param: value } } } }
    //
    // Optional `sinceUpdatedAt` (epoch-seconds cursor from getConfigWatermark) returns rows
    // changed at or after that instant. The cursor is anchored on UNIX_TIMESTAMP(updated_at): a
    // plain integer that survives JSON round-trips with no timezone ambiguity. Comparison is
    // INCLUSIVE `>=` (item #2265): both sides truncate to whole seconds, so a strict `>` dropped
    // a write committed after the row read but stamped in the same second as the watermark - the
    // client advanced its cursor to that second and the write was never delivered until a full
    // re-fetch. The cost of `>=` is that rows in the cursor second are re-delivered each poll
    // until a newer write lands; consumers merge idempotently, so redelivery is a no-op and the
    // delta is genuinely loss-free without a separate sequence column.
    async getAllConfigs(sinceUpdatedAt){
        let query = "SELECT coin, network, module, param_name, param_value FROM configs";
        let args  = [];
        let since = Number(sinceUpdatedAt);
        if(Number.isFinite(since) && since > 0){
            query += " WHERE UNIX_TIMESTAMP(updated_at) >= ?";
            args.push(since);
        }
        query += " ORDER BY coin, network, module, param_name";
        let rows  = await this.doQuery(query, args);
        let configs = {};
        for(let row of rows){
            let coin    = row.coin;
            let network = row.network;
            let module  = row.module;
            if(!configs[coin]) configs[coin] = {};
            if(!configs[coin][network]) configs[coin][network] = {};
            if(!configs[coin][network][module]) configs[coin][network][module] = {};
            configs[coin][network][module][row.param_name] = row.param_value;
        }
        return configs;
    },

    // High-water mark of the configs table as epoch seconds (newest updated_at, or 0 when empty).
    // Read BEFORE reading the rows: a racing write is excluded from the watermark but included in
    // the rows. The cursor second itself is INCLUSIVE on the next poll (getAllConfigs uses `>=`),
    // so a write stamped in the same second as the watermark - even one committed after the row
    // read - is re-delivered next poll (idempotent merge) rather than skipped. That inclusive
    // redelivery is what makes the delta loss-free at one-second granularity (item #2265).
    async getConfigWatermark(){
        let rows = await this.doQuery("SELECT UNIX_TIMESTAMP(MAX(updated_at)) AS watermark FROM configs");
        let w = rows && rows[0] ? rows[0].watermark : null;
        return w == null ? 0 : Number(w);
    },

    // A liveness probe that reads no table: it resolves when the pool hands out a
    // working connection and the server answers, and rejects otherwise. It sits in
    // this mixin because configs is the one family every hub boots with; the
    // ping and health RPCs race it against a timeout.
    // Moved here from src/api.js:735, src/api.js:753.
    async getDatabaseLivenessProbe(){
        return this.doQuery('SELECT 1', []);
    }
};
