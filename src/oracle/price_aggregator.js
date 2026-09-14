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
 * XChain Hub - Price Aggregator
 *
 * Receives validated PRICE v0 rounds and PRICE v1 user oracle prices
 * from indexers across all chains. Deduplicates by round_number (v0)
 * or by (source_address, action_index) (v1) and writes to the unified
 * price_snapshots / oracle_prices tables in the hub DB.
 *
 * Indexers push to the hub via JSON-RPC after validating PBFT signatures
 * locally, but the hub does NOT take that on trust: every PRICE v0 round
 * is re-verified here: each Ed25519 signature is checked against the
 * canonical round payload, signers must belong to the price-capability
 * validator snapshot at the round's block, and the verified count must
 * meet PBFT quorum before anything is written as 'finalized'. The hub
 * is the cross-chain aggregation point; first valid submission for a
 * given round wins, duplicates are silently ignored.
 *
 * The canonical payload builders and the unsigned rail's admission height stay
 * here, beside the class; every ingest path, the retraction and the derived
 * capability pass live in one part each under price_aggregator/ and are mixed
 * onto the prototype below.
 *
 ********************************************************************/

const EventEmitter      = require('events');
const eq                = require('../equivocation_header.js');
const ah                = require('../lib/admission_height.js');
// The COIN-KEYED producer predicate, taken from the twin rather than from the hub's
// admission seam above, because the seam does not carry it: every SIGNED rail's era block
// is a BTC height, so `ah.isAdmissionEra` reads the BTC key and that is all those rails
// need. oracle_prices is the one unsigned rail and its height is the PUBLISHING chain's,
// so its era must be judged on that chain's own key or an LTC height would be compared
// against a BTC activation. HubDbBroadcaster already reaches the twin directly for the
// same kind of non-canonical read.
const { isMirrorAdmissionProducerActive } = require('../mirror_admission_activation.js');
const { getLogger } = require('../observability');
const logger = getLogger();

// The parts, one per behaviour, each a plain object of methods installed on the
// prototype below. Spelled out rather than read off the directory so a missing or
// extra part is a visible diff.
const ingestGuardsPart        = require('./price_aggregator/ingest_guards.js');
const roundIngestPart         = require('./price_aggregator/round_ingest.js');
const batchIngestPart         = require('./price_aggregator/batch_ingest.js');
const singleIngestPart        = require('./price_aggregator/single_ingest.js');
const retractPart             = require('./price_aggregator/retract.js');
const capabilityDerivationPart = require('./price_aggregator/capability_derivation.js');
const capabilityPersistPart   = require('./price_aggregator/capability_persist.js');

const PARTS = [ingestGuardsPart, roundIngestPart, batchIngestPart, singleIngestPart,
               retractPart, capabilityDerivationPart, capabilityPersistPart];

class PriceAggregator extends EventEmitter {

    constructor(hub) {
        super();
        this.hub = hub;
        this.db  = hub.db;
        // Per-source-chain throttle state for the ingest-fence rejection
        // warning ({ last: ms, suppressed: n }). See warnIngestFenceRejection.
        this._fenceWarnState = new Map();
        // Per-source-chain state for the ingest pair-coverage check
        // ({ seen: Set, last: ms, suppressed: n, rounds: n }). See checkIngestPairCoverage.
        this._missingPairWarnState = new Map();
        // Out-of-band round rejections, surfaced through the oracle
        // diagnostics RPC. Monotonic for the process, same posture as the other
        // ingest counters here: the log carries the driver line, this is the read tier.
        this.implausibleRoundRejections = 0;
        this.lastImplausibleRound = null;
        // Derived capability snapshots (chain-only hubs). Timer handle, re-entrancy
        // latch, the BTC heights this process has already covered, and the heights whose
        // last attempt failed loudly (so the failure is named once rather than once per
        // pass). Both are keyed PER CAPABILITY (Map<capability, Set<height>>) because a
        // height covered for `price` says nothing about whether `attestation` was
        // resolved there, and collapsing them would mark three capabilities covered on
        // the strength of a fourth. Every set is pruned to the lookback window on every
        // pass, so none can grow past it.
        this._priceCapDeriveTimer   = null;
        this._priceCapDeriveRunning = false;
        this._capDerivedBlocks      = new Map();
        this._capWarnedBlocks       = new Map();
        // Counters for the diagnostics tier, same posture as the ingest counters above.
        this.priceCapabilityBlocksDerived = 0;
        this.priceCapabilityRowsDerived   = 0;
    }

    // Build the canonical signable payload for a PRICE v0 round.
    // MUST match xchain-indexer/src/consensus/ed25519.js buildPriceV0Payload (and
    // OracleConsensus._buildPriceV0Payload) exactly; validators signed these
    // bytes, so any divergence here rejects every legitimate round.
    //
    // `admitBlocks` is the round's admission map, the per-chain heights at which the round
    // becomes readable. This is the VERIFIER half: the map must be the one the producer
    // signed, so it is read off the round being verified rather than resolved from this
    // hub's own tips, which would rebuild heights no signature covers. Omitted is the
    // legacy round, which is every round below the activation.
    _buildPriceV0Payload(round, timestamp, pairs, btcBlockHeight, admitBlocks) {
        let sortedPairs = pairs
            .map(p => ({ pair: p.coinPair || p.pair, price: String(p.price) }))
            .sort((a, b) => {
                if (a.pair < b.pair) return -1;
                if (a.pair > b.pair) return 1;
                return 0;
            });
        let raw = JSON.stringify({
            round:            parseInt(round),
            timestamp:        parseInt(timestamp),
            btc_block_height: parseInt(btcBlockHeight),
            pairs:            sortedPairs
        });
        // The admission map, height-gated on the round's OWN BTC anchor and never on a
        // consumer's height, so the era for a round is fixed when it is signed and the two
        // eras can never share a signature. Refuses in BOTH directions. Appended to the
        // body BEFORE the EQUIV wrapper, the same position every other rail puts it in, so
        // the wrapper stays a pure function of the bytes it wraps.
        raw += ah.admissionCanonicalField('PriceAggregator', this.hub && this.hub.network,
                                          btcBlockHeight, admitBlocks);
        // EQUIV header (WI-2 bump 2): gated on the round's BTC block HEIGHT + the hub's
        // network, byte-matching ed25519.buildPriceV0Payload. The height is in the signed
        // content and on-chain wire so every service flips on the same anchor (#4232).
        // XORACLE has no view change → VIEW=0; ROUND_ID is the BTC height.
        if (eq.isEquivHeaderActive(btcBlockHeight, this.hub && this.hub.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, parseInt(btcBlockHeight), 0, raw);
        return raw;
    }

    // Build the canonical signable payload for a PRICE batch: ONE signature set over
    // several rounds. MUST match xchain-indexer/src/consensus/ed25519.js buildPriceBatchPayload and
    // OracleConsensus._buildPriceBatchPayload byte for byte; validators signed these bytes,
    // so any divergence here rejects every legitimate batch.
    //
    // `rounds` is [{ round, timestamp, btcBlockHeight, pairs }] and each `pairs` entry is
    // { pair | coinPair, price }. The builder sorts the rounds ascending and normalizes
    // each round's pairs itself rather than requiring sorted input, so no caller of the
    // three twins can get the ordering contract subtly wrong.
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
                let admit = ah.admissionCanonicalValue('PriceAggregator', network, parseInt(r.btcBlockHeight),
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
        // which would read as equivocation. XORACLEB has no view change → VIEW=0.
        let roundId = String(parseInt(btcBlockHeight)) + '|' +
                      String(parseInt(firstRound))     + '|' +
                      String(parseInt(lastRound));
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, roundId, 0, raw);
    }

    // The admission height for ONE PRICE v1 row, or null (R5 (a), spec section 5.4).
    //
    // oracle_prices is the family's only UNSIGNED rail: no signatures, no canonical, and
    // nothing on the wire to stamp a map into. So its admission height is a single scalar on
    // the PUBLISHING chain, which source_chain already names, and the barrier certifies it
    // against heights[oracle_prices][source_chain] rather than against the reading chain's
    // own B. That is why the column is one unqualified `admit_block` and not the three-chain
    // map every signed rail carries.
    //
    // NULL IS THE ONLY FAILURE VALUE, and the distinction matters more here than anywhere
    // else on this path: isRowReadableAt binds a NULL row by effective_time at every height,
    // so an unstamped row is exactly today's row, while a zero would be a row admissible at a
    // block every live chain passed years ago. Every failure this method knows about (an
    // unusable chain, a hub with no admission resolver, an RPC error, a frozen or absent
    // decoder tip, a read set the seam refuses) therefore answers null rather than guessing.
    //
    // THE ERA IS JUDGED ON THE PUBLISHING CHAIN'S OWN TIP, not on a BTC height, because this
    // row has no BTC anchor and no height of any kind. That costs nothing in soundness: the
    // rail is unsigned, so no two hubs have to agree on any bytes, and two hubs that disagree
    // about whether to stamp produce one height-bound row and one legacy row, both of which
    // are safe to read. Below the activation this answers null and the row is byte-identical
    // to today's.
    async resolveOracleAdmitBlock(sourceChain) {
        let readSet;
        try {
            // The seam's own rule for this table (publishingChain), including its refusal of a
            // row carrying no source_chain: a height with no chain to verify it against is not
            // a weaker stamp, it is an unverifiable one.
            readSet = ah.admissionReadSet('oracle_prices', { source_chain: sourceChain });
        } catch (e) {
            logger.warn('PriceAggregator: no admission read set for this PRICE v1 row (' +
                (e && e.message) + '); storing it as a legacy row.');
            return null;
        }
        let chain = readSet[0];

        if (!this.hub || typeof this.hub.resolveAdmissionTip !== 'function') return null;
        let tip;
        try {
            tip = await this.hub.resolveAdmissionTip(chain);
        } catch (e) {
            logger.warn('PriceAggregator: the ' + chain + ' admission tip threw (' + (e && e.message) +
                '); storing this PRICE v1 row as a legacy row.');
            return null;
        }
        // typeof, not a coercing check: Number(null) and Number('') are both 0, so a coerced
        // guard would read an ABSENT tip as height 0 and stamp 0 + margin. resolveAdmissionTip
        // answers null for every failure it handles, and null is not tip zero.
        if (typeof tip !== 'number' || !Number.isSafeInteger(tip) || tip < 0) return null;

        if (!isMirrorAdmissionProducerActive(chain, this.hub && this.hub.network, tip)) return null;

        try {
            // tip + admitMarginBlocks('oracle_prices'), through the one stamp definition, so
            // this rail cannot drift from the margin the barrier certifies it against.
            return ah.admitBlocks(readSet, { [chain]: tip }, 'oracle_prices')[chain];
        } catch (e) {
            logger.warn('PriceAggregator: could not stamp an admission height for a ' + chain +
                ' PRICE v1 row (' + (e && e.message) + '); storing it as a legacy row.');
            return null;
        }
    }
}

// Install one part's methods on the prototype, non-enumerably, exactly as
// src/db/index.js installMixins does for the database families: enumerable false keeps a
// moved method indistinguishable from one still declared in the class above, so for...in
// and Object.keys(PriceAggregator.prototype) report what they reported before the split;
// writable and configurable stay true so a test can still stub and restore a moved
// method. A name already on the prototype throws rather than overwriting, because two
// parts (or a part and the class) claiming one name is a collision the loader must name
// at boot, not a silent last-part-wins.
function installParts(target, parts) {
    for (const part of parts) {
        const descriptors = {};
        for (const name of Object.keys(part)) {
            if (Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('Duplicate PriceAggregator method: ' + name + ' is already defined on ' +
                    'PriceAggregator.prototype. Two parts, or a part and the class, claim the same name.');
            descriptors[name] = { value: part[name], enumerable: false, writable: true, configurable: true };
        }
        Object.defineProperties(target, descriptors);
    }
}

installParts(PriceAggregator.prototype, PARTS);

// The admission seam. Tests re-arm the mirror-admission activation by purging this file
// and lib/admission_height.js from the require cache and loading both again, which
// reloads this shell but not its already-cached parts. A part that required
// admission_height itself would keep the unarmed copy, so the parts read the copy THIS
// shell loaded, through the prototype.
Object.defineProperty(PriceAggregator.prototype, 'admission',
    { value: ah, enumerable: false, writable: true, configurable: true });

module.exports = PriceAggregator;
