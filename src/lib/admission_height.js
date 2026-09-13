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
 * XChain Hub - the PRODUCER half of admission by height.
 *
 * A mirrored row used to bind at an indexer's block B when its signed
 * effective_time was <= t(B), the block's own protocol timestamp. Bitcoin
 * consensus accepts a stamp up to 7200 s ahead of network time, so one VALID
 * forward-stamped block held a hub-connected indexer's whole block loop for that
 * distance. Heights do not move with stamps, so the binding rule moves onto the
 * height axis: every mirrored row carries a signed ADMISSION HEIGHT per chain
 * that reads it, and chain C binds the row at B when admit_blocks[C] <= B.
 *
 * This module is the hub-side producer of that map. The consensus CONSTANTS, the
 * activation predicates AND the canonical encoder live in
 * mirror_admission_activation.js, the byte-identical twin shared with the indexer and
 * the explorer; nothing here is re-derived from them and nothing here is duplicated
 * into them, because this file carries hub-only knowledge (the read sets, the mirror
 * columns, the refusal policy) that the vendored client must not grow a dependency on.
 *
 * Three things live here, and each one is a separate failure the design names:
 *
 *   1. THE READ SETS (section 5.1). Which chains read a row decides which chains
 *      its map must cover. Measured from the consuming selects, not guessed.
 *   2. THE STAMP. admitBlocks() is tip + margin on every chain in the read set,
 *      the SAME block count on each, because the margin is a block count on the
 *      admission axis rather than a duration that has to be converted per chain.
 *   3. THE FOLLOWER BOUND, per chain. A flat block window would collapse DOGE's
 *      clock-skew tolerance from an hour to six minutes and refuse honest rows.
 *
 * The canonical ENCODING, which must be injective or one honest quorum's signatures
 * validate over two different maps, is the one piece that moved out: the hub signs those
 * bytes and every indexer rebuilds them, so it belongs in the twin and is re-exported at
 * the bottom of this file.
 *
 **********************************************************************/

'use strict';

// The canonical ENCODER and the era gate moved into the twin when the price rail joined
// the family: the hub signs those bytes and every indexer rebuilds them, so a hub-only
// encoder would have needed a second copy in the indexer that no parity suite could hold
// (they compare exported constants, and two copies of a function drift green). They are
// re-exported at the bottom of this file so this module stays the hub's one admission
// seam, with exactly one DEFINITION of each per repo.
const {
    ADMIT_MIN_FUTURE_BLOCKS,
    admitMarginBlocks,
    admitMaxFutureBlocks,
    isAdmitBlockInFollowerBound,
    CHAIN_CODE_RE,
    encodeAdmitBlocks,
    decodeAdmitBlocks,
    isAdmissionEra,
    admissionCanonicalField,
    admissionCanonicalValue,
    ADMIT_COLUMN_CHAINS,
    columnsAdmitBlocks,
} = require('../mirror_admission_activation.js');

// ---------------------------------------------------------------------------
// The read sets, measured from the consuming selects (spec section 5.1)
// ---------------------------------------------------------------------------

/*
 * `every: true` marks a rail whose consumers carry NO chain clause at all, so
 * every chain the federation serves reads every row. Policy snapshots are the
 * sharp case: `SELECT * FROM policy_snapshots WHERE status='finalized' AND
 * network=? AND effective_time<=?` has no chain column in it, so a map covering
 * only the pair's own chains would leave the row unadmitted everywhere else.
 *
 * Per mirrored table: the row fields naming its readers, or EVERY_CHAIN, or a
 * fixed chain list. Sourced from the consuming query in each case:
 *
 *   cross_chain_matches      indexer db.js:9764, hub_db_sync.js:4196   a_chain OR b_chain
 *   cross_chain_calls        indexer db.js:10254, :10305, :4208        target_chain OR source_chain
 *   bridge_transfers         bridge_settle.js:1021                     dest_chain
 *   policy_snapshots         bridge_settle.js:1045-1050                no chain clause at all
 *   attestation_responses    XChainIndexer.js:1517 call-site guard     BTC only
 *   anchor_reward_attestations  XChainIndexer.js:1495 same guard       BTC only
 *   oracle_prices            XChainIndexer.js:1336                     every chain
 *   price_snapshots          XChainIndexer.js:1366                     every chain
 *
 * A table absent from this map has no measured read set, and guessing one is the
 * failure this table exists to prevent, so admissionReadSet() throws rather than
 * defaulting.
 */
const ADMISSION_READ_SETS = Object.freeze({
    cross_chain_matches:        Object.freeze({ fields: Object.freeze(['a_chain', 'b_chain']) }),
    cross_chain_calls:          Object.freeze({ fields: Object.freeze(['target_chain', 'source_chain']) }),
    bridge_transfers:           Object.freeze({ fields: Object.freeze(['dest_chain']) }),
    policy_snapshots:           Object.freeze({ every: true }),
    attestation_responses:      Object.freeze({ chains: Object.freeze(['BTC']) }),
    anchor_reward_attestations: Object.freeze({ chains: Object.freeze(['BTC']) }),
    // The one UNSIGNED rail, and the one that takes a scalar rather than a map. It carries no
    // signatures and no canonical, so there is nothing to stamp a map into; its admission
    // height is the PUBLISHING chain's, named by the row's own source_chain, and the barrier
    // certifies it against that chain's watermark rather than the reading chain's own B.
    oracle_prices:              Object.freeze({ publishingChain: true }),
    price_snapshots:            Object.freeze({ every: true }),
});

/**
 * Normalise a chain code the way the rest of the admission path spells it.
 * Returns null for anything outside the closed vocabulary, which every caller
 * treats as a refusal rather than a coercion.
 */
function normalizeChain(chain){
    if(chain === null || chain === undefined) return null;
    let c = String(chain).trim().toUpperCase();
    return CHAIN_CODE_RE.test(c) ? c : null;
}

// ---------------------------------------------------------------------------
// The mirror COLUMNS the map is stored in, and the map a stored row carries
// ---------------------------------------------------------------------------

// The column list and the column reader live in the twin (ADMIT_COLUMN_CHAINS,
// columnsAdmitBlocks), because every indexer rebuilds the signed field from the same
// mirrored columns the hub writes and a second list on this side could drift. Both are
// re-exported below; what stays here is the in-memory shape a round carries.

/** The mirror column holding chain `c`'s admission height. */
function admitColumn(chain){
    let c = normalizeChain(chain);
    if(c === null) throw new Error('admission_height: no admission column for chain ' + JSON.stringify(String(chain)));
    return 'admit_block_' + c.toLowerCase();
}

/**
 * The admission map a stored or wire row carries, or null for a legacy row.
 *
 * A row may carry the map two ways and they must agree: `admit_blocks` in memory
 * during a round, and the per-chain columns once it is persisted or mirrored.
 * A row carrying BOTH shapes with different contents is refused rather than
 * resolved, because picking one would let a leader show followers one map and
 * verifiers another and still collect a quorum over bytes neither can reproduce.
 */
function rowAdmitBlocks(row){
    let r = row || {};
    let fromCols = columnsAdmitBlocks(r);
    let inMem = (r.admit_blocks !== null && r.admit_blocks !== undefined && typeof r.admit_blocks === 'object')
        ? r.admit_blocks : null;
    if(inMem === null) return fromCols;
    // Normalised through the encoder so the comparison is over the exact bytes
    // that would be signed, not over two object shapes.
    if(fromCols !== null && encodeAdmitBlocks(inMem) !== encodeAdmitBlocks(fromCols))
        throw new Error('admission_height: the row\'s admit_blocks (' + encodeAdmitBlocks(inMem) +
            ') disagrees with its stored admission columns (' + encodeAdmitBlocks(fromCols) + ')');
    return inMem;
}

/**
 * The column assignments for an admission map: every federation column named, so
 * an INSERT sets the chains in the map and NULLs the rest rather than leaving
 * them to a default a later schema edit could change under a signed row.
 */
function admitBlocksToColumns(map){
    let out = {};
    for(let c of ADMIT_COLUMN_CHAINS){
        let v = (map && Object.prototype.hasOwnProperty.call(map, c)) ? map[c] : null;
        out['admit_block_' + c.toLowerCase()] = (v === null || v === undefined) ? null : Number(v);
    }
    return out;
}

/**
 * The chains that READ `row` from `table`: the row's own map of admission
 * heights must name exactly these.
 *
 * @param {string} table the mirrored table name
 * @param {object} row the row being produced (unused for fixed and every-chain rails)
 * @param {string[]} federationChains every chain this federation serves, needed
 *        only by the every-chain rails; an empty list there is a refusal, not an
 *        empty map, because an empty map admits the row nowhere
 * @returns {string[]} deduplicated, ASCII-sorted chain codes
 */
function admissionReadSet(table, row, federationChains){
    let spec = Object.prototype.hasOwnProperty.call(ADMISSION_READ_SETS, String(table))
        ? ADMISSION_READ_SETS[String(table)] : null;
    if(!spec)
        throw new Error('admission_height: no measured read set for table ' + JSON.stringify(String(table)) +
            '; a guessed read set leaves the row unadmitted on a chain that reads it');

    let raw;
    if(spec.publishingChain){
        // The unsigned rail. Its admission height is a single scalar on the PUBLISHING chain,
        // named by the row's own source_chain, so the "read set" is that one chain no matter
        // how many chains read the row: the barrier certifies it against that chain's
        // watermark rather than against the reading chain's own B.
        let src = (row || {}).source_chain;
        if(src === null || src === undefined || String(src).trim() === '')
            throw new Error('admission_height: ' + table + ' admits on the PUBLISHING chain and the row ' +
                'carries no source_chain; refusing to stamp a height with no chain to verify it against');
        raw = [src];
    } else if(spec.every){
        raw = Array.isArray(federationChains) ? federationChains : [];
        if(raw.length === 0)
            throw new Error('admission_height: ' + table + ' is read by EVERY chain and no federation chain ' +
                'list was supplied; refusing to stamp an empty admission map');
    } else if(spec.chains){
        raw = spec.chains.slice();
    } else {
        raw = spec.fields.map((f) => (row || {})[f]);
    }

    let out = [];
    for(let c of raw){
        let n = normalizeChain(c);
        if(n === null)
            throw new Error('admission_height: ' + table + ' read set contains an unusable chain ' +
                JSON.stringify(String(c)) + '; refusing to stamp a map that cannot be encoded');
        if(out.indexOf(n) === -1) out.push(n);
    }
    // A same-chain match names one chain twice; the map has one entry for it.
    out.sort();
    return out;
}

// ---------------------------------------------------------------------------
// The stamp
// ---------------------------------------------------------------------------

/**
 * Which chains in `readSet` this hub has NO usable admission tip for.
 *
 * The fresh-tip precondition (C4) is the whole reason this is a separate
 * function: above the activation a hub with no fresh tip for any chain in the
 * read set must REFUSE to finalize the row rather than guess a height. A guessed
 * admission height forks (peers stamp different maps for the same row and their
 * signatures never agree); a refusal only stalls one rail, loudly.
 *
 * A tip is usable only when it is a NUMBER that is a non-negative safe integer.
 * The typeof check is load-bearing rather than defensive: Number('') and
 * Number(null) are both 0, a finite non-negative integer, so a coercing check
 * would read a missing tip as height 0 and stamp an admission height of 0 +
 * margin, which every live chain has already passed. That is the guessed height
 * this whole precondition exists to refuse, arrived at silently.
 *
 * `null` is what XChainHub._resolveAdmissionTip returns for every failure it
 * knows about: no indexer URL, an RPC error, a missing decoder_block, or a tip
 * its per-chain freshness gate dated as frozen.
 */
function missingAdmissionTips(readSet, tips){
    let missing = [];
    for(let chain of (readSet || [])){
        let c = normalizeChain(chain);
        if(c === null){ missing.push(String(chain)); continue; }
        let t = (tips || {})[c];
        if(typeof t !== 'number' || !Number.isSafeInteger(t) || t < 0) missing.push(c);
    }
    return missing;
}

/**
 * The admission map for a row: `tip + admitMarginBlocks(table)` on every chain in
 * the read set.
 *
 * The SAME block count on every chain, deliberately. On the seconds axis a
 * producer sized its forward margin as 4 blocks of the gating chain and then
 * CONVERTED it to seconds, which is why the seconds axis needs a nominal block
 * interval per chain and a default for an unknown one. Deleting the conversion
 * deletes both: four blocks of DOGE and four blocks of BTC are four blocks each.
 *
 * Fails closed and says which chain: a partial map would admit the row on some
 * chains and silently leave it to the legacy effective_time rule on the rest,
 * which is two binding rules for one row.
 *
 * @param {string[]} readSet the chains that read the row (admissionReadSet)
 * @param {object} tips chain code -> this hub's fresh admission tip for it
 * @param {string} table the mirrored table, which picks the margin
 * @returns {object} chain code -> admission height
 */
function admitBlocks(readSet, tips, table){
    let chains = (readSet || []).map(normalizeChain);
    if(chains.length === 0 || chains.indexOf(null) !== -1)
        throw new Error('admission_height: refusing to stamp an admission map over read set ' +
            JSON.stringify(readSet));

    let missing = missingAdmissionTips(chains, tips);
    if(missing.length > 0)
        throw new Error('admission_height: no fresh admission tip for ' + missing.join(', ') +
            ' (read set ' + chains.join(', ') + '); refusing to stamp an admission map for ' + String(table) +
            '. A guessed admission height forks; this refusal stalls one rail.');

    let margin = admitMarginBlocks(table);
    let map = {};
    for(let c of chains) map[c] = Number(tips[c]) + margin;
    return map;
}

// ---------------------------------------------------------------------------
// The follower bound, per chain
// ---------------------------------------------------------------------------

/**
 * Does a proposed admission map pass this follower's own per-chain bound?
 *
 * Two refusals, and they are different failures:
 *
 *  - THE MAP OMITS A CHAIN IN THE READ SET. A leader that stamps only the chains
 *    it happens to have a tip for produces a row that binds by height on one
 *    chain and by effective_time on another, which is exactly the split the
 *    design exists to remove. Refused at proposal time (C38's producer half);
 *    the CONSUMER-side rule for an already-signed row whose map omits C is the
 *    legacy rule in isRowReadableAt, which is a different question.
 *  - AN ENTRY IS OUTSIDE [ownTip + 1, ownTip + ADMIT_MAX_FUTURE_BLOCKS(c)]. The
 *    upper bound is per chain because it is sized to span the same 3600 s on
 *    every chain: BTC 6 blocks, LTC 24, DOGE 60. A flat 6 would refuse honest
 *    rows between DOGE hubs whose tips differ by three blocks.
 *
 * This does NOT retire the absolute effective_time bounds each engine already
 * applies. A follower refuses on both axes, so a hub with a broken clock and a
 * hub with a wrong tip are each caught by the axis that can see them.
 *
 * @param {string[]} readSet chains the row is read by
 * @param {object} map the proposed admit_blocks
 * @param {object} ownTips this follower's own admission tip per chain
 * @returns {{ok: boolean, chain: (string|null), reason: (string|null)}}
 */
function checkAdmitBlocks(readSet, map, ownTips){
    let chains = (readSet || []).map(normalizeChain);
    if(chains.length === 0 || chains.indexOf(null) !== -1)
        return { ok: false, chain: null, reason: 'unusable read set ' + JSON.stringify(readSet) };
    if(!map || typeof map !== 'object')
        return { ok: false, chain: null, reason: 'no admission map' };

    for(let c of chains){
        if(!Object.prototype.hasOwnProperty.call(map, c))
            return { ok: false, chain: c, reason: 'the admission map omits ' + c + ', which reads this row' };
        let own = (ownTips || {})[c];
        if(own === null || own === undefined || !Number.isInteger(Number(own)) || Number(own) < 0)
            return { ok: false, chain: c, reason: 'no own admission tip for ' + c + ' to bound against' };
        if(!isAdmitBlockInFollowerBound(c, map[c], Number(own)))
            return { ok: false, chain: c, reason: 'admit_blocks[' + c + '] = ' + String(map[c]) +
                ' is outside [' + (Number(own) + ADMIT_MIN_FUTURE_BLOCKS) + ', ' +
                (Number(own) + admitMaxFutureBlocks(c)) + '] against own tip ' + Number(own) };
    }
    // An entry for a chain NOT in the read set is a leader stamping a height no
    // consumer will ever compare. Harmless to bind but not harmless to sign, so
    // it is refused: the map must be a function of the row.
    for(let k of Object.keys(map))
        if(chains.indexOf(k) === -1)
            return { ok: false, chain: k, reason: 'the admission map carries ' + k + ', which does not read this row' };

    return { ok: true, chain: null, reason: null };
}

/**
 * The whole follower gate for one proposed row: resolve THIS hub's own admission tips for
 * the row's read set, then bound the proposed map against them.
 *
 * One definition, because both follower paths (CrossChainCallEngine.validateProposedMatch
 * and the CrossChainDexConsensus PROPOSE handler) must refuse for the same reasons; two
 * copies would drift into a hub that signs on one path what it refuses on the other, and a
 * federation split by which path saw the row first is the fork this design exists to remove.
 *
 * FAIL-CLOSED ON THE RESOLVER ITSELF. A hub that cannot resolve its own tips has no bound
 * to apply, so it refuses rather than signing a height it never checked. That is the same
 * direction as C4's producer half: a hub with no fresh tip refuses to open the round, and a
 * follower with no fresh tip refuses to co-sign it. `_resolveAdmissionTips` already answers
 * `null` per chain for every failure it knows about (no indexer URL, an RPC error, an
 * absent decoder_block, or a tip its per-chain freshness gate dated as frozen), and
 * checkAdmitBlocks turns each of those into a refusal that names the chain.
 *
 * @param {object} hub the hub, for _resolveAdmissionTips
 * @param {string[]} readSet the chains that read the row (admissionReadSet)
 * @param {object|null} map the proposed admit_blocks
 * @returns {Promise<{ok: boolean, chain: (string|null), reason: (string|null)}>}
 */
async function checkAdmitBlocksAgainstHub(hub, readSet, map){
    if(!hub || typeof hub._resolveAdmissionTips !== 'function')
        return { ok: false, chain: null,
            reason: 'this hub cannot resolve its own admission tips, so it has no bound to hold the ' +
                    'proposed map against; refusing to sign rather than adopting the proposer\'s heights' };
    let ownTips;
    try { ownTips = await hub._resolveAdmissionTips(readSet); }
    catch (err) {
        return { ok: false, chain: null, reason: 'own admission tip read failed: ' + (err && err.message) };
    }
    return checkAdmitBlocks(readSet, map, ownTips);
}

// Re-exported from the twin, where the ENCODER and the era gate live so the hub and every
// indexer build the field from one definition per repo. Named here because this module is
// the hub's admission seam: the engines' canonical builders reach the field through it and
// never require the twin directly, so the hub-only knowledge (read sets, columns, refusal
// policy) and the shared bytes stay one import for a caller and two files for a reviewer.
module.exports = {
    ADMISSION_READ_SETS,
    ADMIT_COLUMN_CHAINS,
    admitColumn,
    rowAdmitBlocks,
    admitBlocksToColumns,
    normalizeChain,
    admissionReadSet,
    missingAdmissionTips,
    admitBlocks,
    checkAdmitBlocks,
    checkAdmitBlocksAgainstHub,
    encodeAdmitBlocks,
    decodeAdmitBlocks,
    isAdmissionEra,
    admissionCanonicalField,
    admissionCanonicalValue,
    columnsAdmitBlocks,
};
