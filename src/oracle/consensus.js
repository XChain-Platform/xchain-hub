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
 * XChain Hub - Oracle Consensus
 *
 * PBFT-like consensus for price oracle rounds. After the submission
 * window closes, the round leader aggregates prices using a trimmed
 * median, proposes the result, and validators vote to finalize it.
 *
 * Flow: ORACLE_PROPOSE -> ORACLE_PREPARE (2f+1) -> ORACLE_COMMIT (2f+1) -> store snapshot
 *
 * Single-node fast path: when quorum === 0 (only one oracle_publish validator),
 * the snapshot is stored immediately without any PROPOSE/PREPARE/COMMIT exchange.
 *
 * The engine is ONE class across this file and the parts under oracle/consensus/: the
 * shell holds construction, the admission-map methods and the canonical payload builders,
 * and each part holds one behaviour, installed on the prototype by installParts below.
 *
 ********************************************************************/

const EventEmitter      = require('events');
const eq                = require('../equivocation_header.js');
const snapWrite         = require('../lib/capability_snapshot_write.js');
const ah                = require('../lib/admission_height.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();

// The constructor's field groups, and the round's per-pair clamp table.
const { initRoundCounters, initRoundTimers, initFinalizedAndEarlyBuffers,
        applyTimingConfig, applyUnverifiedPairsHatch } = require('./consensus/options.js');
const { maxChangeForPair } = require('./consensus/constants.js');

// One behaviour per part, one const each. The literal PARTS list below is what
// installParts iterates, so a part nobody installs is a visible diff rather than a
// silently missing method.
const aggregateMethods      = require('./consensus/aggregate.js');
const clampReferenceMethods = require('./consensus/clamp_reference.js');
const commitMethods         = require('./consensus/commit.js');
const finalizeRoundMethods  = require('./consensus/finalize_round.js');
const handleProposeMethods  = require('./consensus/handle_propose.js');
const lifecycleMethods      = require('./consensus/lifecycle.js');
const membershipMethods     = require('./consensus/membership.js');
const messageMethods        = require('./consensus/messages.js');
const proposeMethods        = require('./consensus/propose.js');
const snapshotStoreMethods  = require('./consensus/snapshot_store.js');
const watchdogMethods       = require('./consensus/watchdog.js');

const PARTS = [aggregateMethods, clampReferenceMethods, commitMethods, finalizeRoundMethods,
               handleProposeMethods, lifecycleMethods, membershipMethods, messageMethods,
               proposeMethods, snapshotStoreMethods, watchdogMethods];

class OracleConsensus extends EventEmitter {

    constructor(hub, oracleRound) {
        super();
        this.hub         = hub;
        this.oracleRound = oracleRound;
        this.peerManager = hub.getPeerManager();
        this.db          = hub.db;

        initRoundCounters.call(this);
        initRoundTimers.call(this);
        initFinalizedAndEarlyBuffers.call(this);

        this.validatorSet = [];

        this._messageHandler = null;

        applyTimingConfig.call(this);
        applyUnverifiedPairsHatch.call(this);
    }

    // Persist the qualifying validator set for `capability` at `block` to
    // capability_snapshots (idempotent) and mirror each row to hub-DB subscribers.
    // Returns the number of rows resolved (and persisted) for this (capability, block);
    // 0 means the set degraded to empty or was refused as truncated.
    //
    // Byte-for-byte the same write and select-back as
    // StateCheckpointEngine/CrossChainCallEngine._persistCapabilitySnapshot: INSERT IGNORE
    // on the natural key is the idempotency primitive (all hubs write identical rows for a
    // block, and a replayed round re-writes nothing), and the select-back keys on the full
    // widened uq_cap_snap (block, capability, pubkey, SOURCE) because a pubkey delegated by
    // two sources has two rows and a pubkey-only LIMIT 1 re-read would stream only one.
    async _persistCapabilitySnapshot(capability, block) {
        let validators = await this.resolveCapabilityValidators(capability, block);
        // SWQ-TRUNC-MIRROR: never mirror a TRUNCATED set. The `.truncated` marker is what
        // fails this hub's own meetsStakeThreshold closed, but it is a JS array property
        // with no capability_snapshots column behind it, so persisting the capped rows
        // would hand an off-BTC verifier a partial set it reads back as COMPLETE and let it
        // clear a 2/3 bar over an under-counted stake denominator this hub itself rejects.
        // Writing nothing leaves the mirror empty, so that read yields S=0 and fails closed
        // through the same predicate as everything else. Keep this in lockstep with the
        // other capability_snapshots writers.
        if (validators && validators.truncated === true) {
            logger.warn('Oracle: refusing to persist a TRUNCATED ' + capability +
                ' capability snapshot at block ' + block +
                ' (over the source cap; raise VALIDATOR_QUERY_LIMIT fleet-wide). No rows mirrored.');
            return 0;
        }
        // One statement for the whole set: a per-row loop left the mirror PARTIAL on any
        // single INSERT throw, and a partial set has no completeness marker so a verifier
        // reads it as COMPLETE. Rationale in lib/capability_snapshot_write.js. Parity with
        // StateCheckpointEngine and the other four writers.
        let rows = await snapWrite.writeCapabilitySnapshotRows(this.db, capability, block, validators);
        for (let row of rows) {
            if (this.hub && this.hub.hubDbBroadcaster) {
                let r = await this.db.getCapabilitySnapshot(block, capability, row.signing_pubkey, row.source);
                if (r.length) this.hub.hubDbBroadcaster.broadcastRow({ table: 'capability_snapshots', row: r[0] });
            }
        }
        return validators.length;
    }

    // Build the canonical signable payload for a PRICE v0 round.
    // MUST match xchain-indexer/src/consensus/ed25519.js buildPriceV0Payload and
    // PriceAggregator._buildPriceV0Payload exactly so signatures produced here verify
    // against the same canonical bytes when indexers parse on-chain PRICE v0 actions. The
    // three twins now append an ADMISSION FIELD after the JSON body and before the EQUIV
    // wrapper; all three spell it the same way or the price rail stops.
    //
    // The map this hub stamps on a round it leads: tip + the price margin on EVERY chain the
    // federation serves, because the price read set is every chain (section 5.1). Null when
    // any tip is stale or absent, which the caller treats as "propose nothing".
    async resolveRoundAdmitBlocks() {
        let hub = this.hub;
        if (!hub || typeof hub.resolveAdmitBlocks !== 'function') return null;
        try { return await hub.resolveAdmitBlocks('price_snapshots', ah.ADMIT_COLUMN_CHAINS.slice()); }
        catch (e) {
            logger.error(nodeUtil.format('Oracle: admission tip read failed:', e && e.message ? e.message : e));
            return null;
        }
    }

    // The follower bound on a proposed map: the shared checker resolves THIS hub's own tips
    // and refuses fail-closed when it cannot. Returns { ok, map } with the map normalised
    // through the encoder, so what is pinned is exactly what will be signed.
    async checkProposedAdmit(admitBlocks) {
        let map;
        try { map = ah.decodeAdmitBlocks(ah.encodeAdmitBlocks(admitBlocks)); }
        catch (e) { return { ok: false, reason: 'is not a canonical admission map (' + (e && e.message) + ')' }; }
        if (map === null) return { ok: false, reason: 'is not a canonical admission map' };
        let verdict = await ah.checkAdmitBlocksAgainstHub(this.hub, ah.ADMIT_COLUMN_CHAINS.slice(), map);
        if (!verdict || !verdict.ok) return { ok: false, reason: (verdict && verdict.reason) || 'fails the follower bound' };
        return { ok: true, map: map };
    }

    // One spelling for "same map or both absent", used to compare two proposals for one round.
    spellAdmit(map) {
        if (map === null || map === undefined) return null;
        try { return ah.encodeAdmitBlocks(map); } catch (e) { return '(unspellable)'; }
    }

    // `admitBlocks` is this round's admission map, the per-chain heights at which the
    // round becomes readable. A price round is read on every chain, so its map names every
    // chain the federation serves, and omitting it is the LEGACY row: correct at every
    // height below the activation and refused above it, because a round signed without the
    // heights its consumers bind on is a round no verifier can rebuild.
    _buildPriceV0Payload(round, btcBlockTime, prices, btcBlockHeight, admitBlocks) {
        let pairs = prices.map(p => ({ pair: p.coinPair || p.pair, price: String(p.price) }));
        let sortedPairs = [...pairs].sort((a, b) => {
            if (a.pair < b.pair) return -1;
            if (a.pair > b.pair) return 1;
            return 0;
        });
        let raw = JSON.stringify({
            round:            parseInt(round),
            timestamp:        parseInt(btcBlockTime),
            btc_block_height: parseInt(btcBlockHeight),
            pairs:            sortedPairs
        });
        // The admission map, height-gated on the round's OWN BTC anchor and never on a
        // consumer's height, so the era for a round is fixed when it is signed and the two
        // eras can never share a signature. Refuses in BOTH directions. Appended to the
        // body BEFORE the EQUIV wrapper, the same position every other rail puts it in, so
        // the wrapper stays a pure function of the bytes it wraps.
        raw += ah.admissionCanonicalField('OracleConsensus', this.hub && this.hub.network,
                                          btcBlockHeight, admitBlocks);
        // EQUIV header (WI-2 bump 2): gated on the round's BTC block HEIGHT + the hub's
        // network, byte-matching ed25519.buildPriceV0Payload. The height is in the signed
        // content and the on-chain wire so every indexer reconstructs identical bytes and
        // flips on the same anchor every other engine uses (#4232). XORACLE has no view ->
        // VIEW=0; ROUND_ID is the BTC height (the real activation anchor).
        if (eq.isEquivHeaderActive(btcBlockHeight, this.hub && this.hub.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, parseInt(btcBlockHeight), 0, raw);
        return raw;
    }

    // Build the canonical signable payload for a PRICE batch: ONE signature set over
    // several rounds. THIS IS THE PRODUCER; xchain-indexer/src/consensus/ed25519.js
    // buildPriceBatchPayload and PriceAggregator._buildPriceBatchPayload must match it byte for
    // byte, or the bytes signed here are not the bytes any verifier checks.
    //
    // `rounds` is [{ round, timestamp, btcBlockHeight, pairs }] and each `pairs` entry is
    // { pair | coinPair, price }, the same shapes the v0 producer already normalizes. The
    // builder sorts the rounds ascending and normalizes each round's pairs itself rather
    // than requiring sorted input, so no caller of the three twins can get the ordering
    // contract subtly wrong.
    //
    // The EQUIV header is UNCONDITIONAL here, unlike _buildPriceV0Payload's height gate.
    // v0 gates because it has pre-flag-day history whose bytes may not move; v2 has none
    // (it is ungated and every network it runs on already has EQUIV active). The
    // unwrapped bare-JSON form is also the exact
    // shape that breaks SLASH's "an ORACLE-tagged canonical always carries `round`"
    // invariant, which is why v2 carries its own engine tag. Do NOT "fix" this into a
    // v0-style gate.
    //
    // Each round carries ITS OWN admission map (`admitBlocks`), era-keyed on that round's
    // own anchor and never on the batch anchor: the map means "the heights at which THIS
    // round's producer observed each chain", and the rounds in an hourly window were
    // opened at different tips, so one map for the batch would sign a claim no producer
    // made. In the admission era the entry gains a LAST key, `admit_blocks`, holding the
    // same canonical spelling the v0 field uses; below it the entry is byte-identical to
    // the pre-admission form and a map is refused.
    _buildPriceBatchPayload(firstRound, lastRound, btcBlockHeight, rounds) {
        let network = this.hub && this.hub.network;
        let sortedRounds = [...rounds]
            .sort((a, b) => parseInt(a.round) - parseInt(b.round))
            .map(r => {
                let pairs = r.pairs.map(p => ({ pair: p.coinPair || p.pair, price: String(p.price) }));
                let sortedPairs = [...pairs].sort((a, b) => {
                    if (a.pair < b.pair) return -1;
                    if (a.pair > b.pair) return 1;
                    return 0;
                });
                let entry = {
                    round:            parseInt(r.round),
                    timestamp:        parseInt(r.timestamp),
                    btc_block_height: parseInt(r.btcBlockHeight),
                    pairs:            sortedPairs
                };
                let admit = ah.admissionCanonicalValue('OracleConsensus', network, parseInt(r.btcBlockHeight),
                                                       r.admitBlocks === undefined ? null : r.admitBlocks);
                if (admit !== null) entry.admit_blocks = admit;
                return entry;
            });
        let raw = JSON.stringify({
            first_round:      parseInt(firstRound),
            last_round:       parseInt(lastRound),
            btc_block_height: parseInt(btcBlockHeight),
            rounds:           sortedRounds
        });
        // ROUND_ID carries the batch anchor AND the round window: two honest batches that
        // split one window differently at the same anchor must not land on one equiv key,
        // which would read as equivocation. XORACLEB has no view change -> VIEW=0.
        let roundId = String(parseInt(btcBlockHeight)) + '|' +
                      String(parseInt(firstRound))     + '|' +
                      String(parseInt(lastRound));
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, roundId, 0, raw);
    }
}

// Install one part's methods on the prototype, non-enumerably, the way src/db/index.js
// installs the database families: enumerable false keeps a moved method indistinguishable
// from one declared in the class body, writable and configurable true keep it stubbable,
// and a name already on the prototype throws rather than overriding it in silence.
function installParts(target, parts) {
    for (const part of parts) {
        const descriptors = {};
        for (const name of Object.keys(part)) {
            if (Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('Duplicate method: ' + name + ' is already defined on ' +
                    'OracleConsensus.prototype. Two parts, or a part and the class, claim the same name.');
            descriptors[name] = { value: part[name], enumerable: false, writable: true, configurable: true };
        }
        Object.defineProperties(target, descriptors);
    }
}

installParts(OracleConsensus.prototype, PARTS);

// The admission seam. The admission tests re-arm the activation by purging this file and
// lib/admission_height.js from the require cache and loading both again, which reloads the
// shell but not its already-cached parts. A part that required admission_height itself
// would keep the unarmed copy, so the parts read the copy THIS shell loaded, through the
// prototype.
Object.defineProperty(OracleConsensus.prototype, 'admission',
    { value: ah, enumerable: false, writable: true, configurable: true });

module.exports = Object.assign(OracleConsensus, {

    // Named export so SlashDetector measures the clamp allowance from the SAME table this
    // module clamps with (item 5833). A second copy of MAX_CHANGE_PER_ROUND_BY_PAIR would
    // let a per-pair retune move the clamp and leave the slash gate on the old allowance,
    // which is the mismatch that finding is about. Default export shape is unchanged.
    maxChangeForPair
});
