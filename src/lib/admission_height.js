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
 * This module is the hub-side producer of that map. The consensus CONSTANTS and
 * the activation predicates live in mirror_admission_activation.js, the
 * byte-identical twin shared with the indexer and the explorer; nothing here is
 * re-derived from them and nothing here is duplicated into them, because this
 * file carries hub-only knowledge (the read sets, the canonical encoding, the
 * refusal policy) that the vendored client must not grow a dependency on.
 *
 * Four things live here, and each one is a separate failure the design names:
 *
 *   1. THE READ SETS (section 5.1). Which chains read a row decides which chains
 *      its map must cover. Measured from the consuming selects, not guessed.
 *   2. THE STAMP. admitBlocks() is tip + margin on every chain in the read set,
 *      the SAME block count on each, because the margin is a block count on the
 *      admission axis rather than a duration that has to be converted per chain.
 *   3. THE FOLLOWER BOUND, per chain. A flat block window would collapse DOGE's
 *      clock-skew tolerance from an hour to six minutes and refuse honest rows.
 *   4. THE CANONICAL ENCODING, which must be injective or one honest quorum's
 *      signatures validate over two different maps.
 *
 **********************************************************************/

'use strict';

const {
    ADMIT_MIN_FUTURE_BLOCKS,
    admitMarginBlocks,
    admitMaxFutureBlocks,
    isAdmitBlockInFollowerBound,
    isMirrorAdmissionProducerActive,
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

// A chain code is a closed vocabulary: upper-case letters and digits, nothing
// else. The canonical encoding's injectivity argument rests on that (no ':' and
// no ',' can appear inside a code), so the check is here and not only in a test.
const CHAIN_CODE_RE = /^[A-Z0-9]{1,10}$/;

// Canonical base-10 spelling of a non-negative integer: digits only, no sign, no
// leading zeros. Same rule lib/canonical_int.js applies to the hub's other signed
// integers, restricted to non-negative because a height never is.
const CANONICAL_HEIGHT_RE = /^(?:0|[1-9][0-9]*)$/;

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

// One nullable BIGINT UNSIGNED column per chain the federation serves, per C28.
// Adding a chain to the federation adds a column here and in the six .sql twins;
// it does NOT make rows signed before that chain existed admissible on it, which
// is C38's fail-closed direction and the reason the map is read back from the
// columns that are actually set rather than from today's chain list.
const ADMIT_COLUMN_CHAINS = Object.freeze(['BTC', 'LTC', 'DOGE']);

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
    let fromCols = null;
    for(let c of ADMIT_COLUMN_CHAINS){
        let v = r['admit_block_' + c.toLowerCase()];
        if(v === null || v === undefined) continue;
        let h = Number(v);
        if(!Number.isSafeInteger(h) || h < 0)
            throw new Error('admission_height: admit_block_' + c.toLowerCase() + ' = ' + JSON.stringify(v) +
                ' is not a usable admission height');
        if(fromCols === null) fromCols = {};
        fromCols[c] = h;
    }
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

// ---------------------------------------------------------------------------
// The canonical encoding, and why it is injective
// ---------------------------------------------------------------------------

/*
 * attest_response_canonical.js:20-55 states the rule an appended canonical field
 * must satisfy, from the case it was written for: concatenated bare,
 * `meta="X" effective=1234` and `meta="X1" effective=234` produce identical
 * bytes, so one honest quorum's signatures would validate over two different
 * values. Two things together fix it, and neither alone: a '|' separator, and a
 * canonical integer spelling.
 *
 * A MAP is strictly harder than one integer, because the field itself now has
 * internal structure that could be re-split. Three properties make this encoding
 * injective, and the test suite drives all three:
 *
 *   1. The chain-code vocabulary is CLOSED upper-case alphanumerics, so neither
 *      ':' nor ',' nor '|' can occur inside a code, and no alternative split of
 *      the field can move a delimiter.
 *   2. Every height is canonically spelled, so 'BTC:1,X:23' and 'BTC:12,X:3' are
 *      different byte strings for different maps (they are), and a map has
 *      exactly ONE spelling: '007' can never appear.
 *   3. Codes are in ASCII order, so {BTC, DOGE} has one encoding rather than two.
 *
 * Without (3) an honest leader and an honest follower could build the same map
 * into different bytes purely from Object key order, which is an insertion-order
 * artefact of how the row was read.
 */

/**
 * Encode an admission map as canonical bytes: `CODE:digits` joined by ',', codes
 * in ASCII order. Throws on anything it cannot spell canonically, because an
 * unspellable map must never reach a signature.
 */
function encodeAdmitBlocks(map){
    if(!map || typeof map !== 'object')
        throw new Error('admission_height: cannot encode a non-object admission map');
    let codes = Object.keys(map);
    if(codes.length === 0)
        throw new Error('admission_height: refusing to encode an EMPTY admission map; a row with no ' +
            'admission height on any chain is a legacy row, and a legacy row carries no field at all');

    let parts = [];
    for(let code of codes.slice().sort()){
        if(!CHAIN_CODE_RE.test(code))
            throw new Error('admission_height: chain code ' + JSON.stringify(code) +
                ' is outside the closed vocabulary the encoding is injective over');
        let v = map[code];
        // Checked on the RAW spelling, never on Number(v): coercing first hides
        // the spelling under test, exactly as lib/canonical_int.js explains.
        let s = (typeof v === 'number') ? (Number.isSafeInteger(v) ? String(v) : null)
              : (typeof v === 'string') ? v : null;
        if(s === null || !CANONICAL_HEIGHT_RE.test(s))
            throw new Error('admission_height: admit_blocks[' + code + '] = ' + JSON.stringify(v) +
                ' is not a canonically spelled non-negative integer height');
        parts.push(code + ':' + s);
    }
    return parts.join(',');
}

/**
 * Decode canonical admission bytes back to a map, or null when the bytes are not
 * the unique canonical encoding of any map.
 *
 * The decoder is strict on purpose: it is the executable statement of what the
 * encoder's injectivity claim means. Round-tripping every encoded map and
 * refusing every non-canonical variant (leading zeros, out-of-order codes, a
 * repeated code, an empty field) is what the test suite checks, and a decoder
 * that accepted variants would make that check vacuous.
 */
function decodeAdmitBlocks(field){
    if(typeof field !== 'string' || field === '') return null;
    let parts = field.split(',');
    let map = {};
    let prev = null;
    for(let p of parts){
        let m = /^([A-Z0-9]{1,10}):((?:0|[1-9][0-9]*))$/.exec(p);
        if(!m) return null;
        let code = m[1];
        if(prev !== null && !(code > prev)) return null;   // out of order, or a repeat
        prev = code;
        let h = Number(m[2]);
        if(!Number.isSafeInteger(h)) return null;
        map[code] = h;
    }
    return map;
}

// ---------------------------------------------------------------------------
// The height-gated era check, one per canonical builder
// ---------------------------------------------------------------------------

/**
 * Is this row in the admission era?
 *
 * Keyed on the ROW's own BTC block (snapshot_block for matches, calls, bridge
 * transfers and policy snapshots; the request's block for attest responses) and
 * never on a consumer's height, so the rule for a given row is fixed the moment
 * it is produced and the two eras can never share a signature.
 *
 * The activation key's COIN is BTC for every rail, because every one of those
 * era blocks IS a BTC height. The map is keyed by (coin, network) so that the
 * CONSUMER side can arm chain by chain; the producer side reads the BTC key.
 */
function isAdmissionEra(network, eraBlock){
    return isMirrorAdmissionProducerActive('BTC', network, eraBlock);
}

/**
 * The canonical tail for a row's admission map: '' below the activation, and
 * '|' + the encoded map at or above it.
 *
 * REFUSES IN BOTH DIRECTIONS, exactly as AttestationConsensus._buildCanonical
 * does for the mirror era (`:1990-2014`). Building a legacy canonical for a
 * modern row strands the row (its signatures reproduce over bytes no verifier
 * rebuilds); building a modern canonical for a legacy row forks a from-genesis
 * replay. Neither can be recovered from downstream, so both throw where the
 * caller that got it wrong is still on the stack.
 *
 * No per-rail canonical VERSION field is minted for this, and none exists
 * anywhere in the hub: this height-gated era check IS the versioning, and a
 * version integer would duplicate the gate while giving a Byzantine leader a
 * second field to disagree about.
 *
 * @param {string} label the engine's canonical tag, for the refusal message
 * @param {string} network the row's network, half the activation key
 * @param {number} eraBlock the ROW's own BTC block
 * @param {object|null} map the row's admission map, or null for a legacy row
 * @returns {string} '' or '|' + encodeAdmitBlocks(map)
 */
function admissionCanonicalField(label, network, eraBlock, map){
    let era = isAdmissionEra(network, eraBlock);
    let has = (map !== null && map !== undefined);
    if(era && !has)
        throw new Error(label + ': admission-era row at block ' + String(eraBlock) + ' on ' + String(network) +
            ' has no admit_blocks; refusing to build a legacy canonical');
    if(!era && has)
        throw new Error(label + ': legacy-era row at block ' + String(eraBlock) + ' on ' + String(network) +
            ' was handed admit_blocks ' + JSON.stringify(map) + '; refusing to build an admission-era canonical');
    if(!era) return '';
    return '|' + encodeAdmitBlocks(map);
}

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
    encodeAdmitBlocks,
    decodeAdmitBlocks,
    isAdmissionEra,
    admissionCanonicalField,
};
