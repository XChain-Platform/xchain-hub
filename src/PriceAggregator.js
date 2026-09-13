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
 ********************************************************************/

const EventEmitter      = require('events');
const ValidatorIdentity = require('./ValidatorIdentity.js');
const eq                = require('./equivocation_header.js');
const pricePair         = require('./price_pair_activation.js');
const priceScale        = require('./price_scale_activation.js');
const priceSigTally     = require('./price_sig_tally_activation.js');
const swq               = require('./stake_weighted_quorum.js');
const { PRICE_MAX, PRICE_V1_COINS, PRICE_V1_FIATS,
        MAX_TICK_LENGTH, MAX_MEMO_LENGTH, MAX_SOURCE_ADDRESS_LENGTH } = require('./constants.js');
const { PRICE_BATCH_MAX_ROUND_COUNT } = require('./price_batch_compression.js');
const { bcgt }          = require('./bcmath.js');
const { bftQuorumOrSingle } = require('./lib/bft_quorum.js');
const { normalizeRetractionBounds } = require('./lib/retraction_bounds.js');
const roundBandLib      = require('./lib/oracle_round_band.js');
const snapWrite         = require('./lib/capability_snapshot_write.js');
const ah                = require('./lib/admission_height.js');
// The COIN-KEYED producer predicate, taken from the twin rather than from the hub's
// admission seam above, because the seam does not carry it: every SIGNED rail's era block
// is a BTC height, so `ah.isAdmissionEra` reads the BTC key and that is all those rails
// need. oracle_prices is the one unsigned rail and its height is the PUBLISHING chain's,
// so its era must be judged on that chain's own key or an LTC height would be compared
// against a BTC activation. HubDbBroadcaster already reaches the twin directly for the
// same kind of non-canonical read.
const { isMirrorAdmissionProducerActive } = require('./mirror_admission_activation.js');
const { positiveIntConfig } = require('./lib/config_int.js');

// Minimum gap between ingest-fence rejection warnings for the SAME source
// chain. Sized so a stalled rail keeps re-announcing itself in any log tail while a
// replaying pusher cannot drown the log; the suppressed count rides on the next line.
const FENCE_WARN_INTERVAL_MS = 60_000;

// Minimum gap between missing-pair coverage warnings for the SAME source chain.
// Same sizing rationale as FENCE_WARN_INTERVAL_MS: a pair that stays gone keeps
// re-announcing itself in any log tail, without one stalled feed flooding the log.
const MISSING_PAIR_WARN_INTERVAL_MS = 60_000;

// ── Derived capability snapshots ────────────────────────────────────────────
// Every capability the consensus path persists into capability_snapshots, and so
// every capability a chain-only hub must derive for itself. Row 45 built this pass
// for `price` alone, which left a standalone node failing closed on ATTEST and
// storing ANCHOR archive heads `unverified` (measured on the testnet chain-only node
// 2026-09-09: 1,148 rows, all `price`, no other capability at any height).
//
// The consensus writers this mirrors, one per name:
//   price          OracleConsensus._persistCapabilitySnapshot (round finalization)
//   oracle_publish StateCheckpointEngine.js:477,866  (the ANCHOR archive-head verifier)
//   cross_chain    CrossChainCallEngine.js:721, RetractionConsensus.js:393,
//                  CrossChainDexConsensus.js:326,377, CrossChainDexEngine.js:712
//   attestation    AttestationBatchPublisher.js:722  (the v5 ATTEST head verifier)
//
// `cross_chain` is written by engines whose _persistCapabilitySnapshot takes a third
// `network` argument, and that argument is NOT a per-row scope this pass cannot supply.
// capability_snapshots has no network column (lib/capability_snapshot_write.js COLUMNS)
// and every reader keys on (capability, snapshot_block) alone (xchain-indexer db.js
// getCapabilitySnapshotWeights / getCapabilitySnapshotValidators / getCapabilitySnapshotCount
// / isPubkeyInCapabilitySnapshot). The argument feeds exactly two things: the
// STAKE_WEIGHTED_QUORUM activation key, whose map is keyed mainnet/testnet/regtest, and
// btc_chain_id, a transport column in no reader's WHERE. Both are properties of the HUB's
// own deployment network, which a standalone hub knows as this.hub.network, so the rows
// this pass writes for `cross_chain` are the same rows the engines write.
const DERIVED_CAPABILITIES = ['price', 'oracle_publish', 'cross_chain', 'attestation'];

// The XChainHub properties that hold each capability's consensus writer, one entry per
// name in DERIVED_CAPABILITIES and drawn from the same writer list above. Presence of
// ANY of a capability's engines means the consensus path on this hub already covers it,
// so the derivation pass skips that capability and only that capability. The engines
// are built by startOracle / startCrossChain / startAttestation, each of which gates
// only on a peer manager, which is why engine presence alone cannot distinguish a
// validator from a mesh-only hub and _runsConsensusFor pairs it with the signing
// identity. See _runsConsensusFor.
const CAPABILITY_CONSENSUS_ENGINES = {
    price:          ['oracleConsensus'],
    oracle_publish: ['stateCheckpoints'],
    cross_chain:    ['crossChainCalls', 'crossChainDex', 'retractionConsensus'],
    attestation:    ['attestationBatchPublisher']
};

// How far back from the BTC tip a hub that does NOT run oracle consensus keeps
// capability_snapshots rows. It has to be a WINDOW rather than a single
// height because the hub never learns which anchor it needs: the indexer resolves
// a landed batch's quorum against capability_snapshots BEFORE it pushes anything,
// so an anchor the hub has not already covered produces no push to learn from.
// 144 blocks is ~1 day of Bitcoin, which covers a node following the tip and a
// day of catch-up; a deeper chain-only bootstrap raises it by config.
const PRICE_CAP_DERIVE_LOOKBACK_BLOCKS = 144;

// Seconds between derivation passes. One pass costs at most one indexer RPC per
// uncovered height, and the batch rail publishes hourly, so a minute is far
// finer-grained than anything it feeds.
const PRICE_CAP_DERIVE_INTERVAL_S = 60;

// Ceiling on the (capability, height) pairs ONE pass resolves. The first pass of a
// cold hub has the whole lookback window to fill for every capability, and doing that
// in a single tick would fire 144 * DERIVED_CAPABILITIES RPCs at the Bitcoin indexer at
// boot. The unit is the RPC, not the height, so widening the capability list did not
// widen this budget. The pass walks newest-first and covers ALL capabilities at a height
// before it steps back one, so the tip (what a node following the chain needs next) is
// fully covered first and the backfill trails behind it over the following ticks.
const PRICE_CAP_DERIVE_MAX_PER_TICK = 64;

class PriceAggregator extends EventEmitter {

    constructor(hub) {
        super();
        this.hub = hub;
        this.db  = hub.db;
        // Per-source-chain throttle state for the ingest-fence rejection
        // warning ({ last: ms, suppressed: n }). See _warnIngestFenceRejection.
        this._fenceWarnState = new Map();
        // Per-source-chain state for the ingest pair-coverage check
        // ({ seen: Set, last: ms, suppressed: n, rounds: n }). See _checkIngestPairCoverage.
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

    // The plausible round band for THIS hub, or null when the local oracle
    // schedule is unresolvable (a mirror hub built without an OracleRound, a
    // test double, a hub whose clock predates ORACLE_EPOCH_START).
    //
    // Null means "no opinion" and every caller must treat it that way. A hub
    // that cannot resolve its own schedule must not start refusing its
    // federation's consensus output on a guess; see lib/oracle_round_band.js.
    _roundBand() {
        let oracle = this.hub && this.hub.oracle;
        if (!oracle) return null;
        return roundBandLib.roundBand({
            epochStartMs:    oracle.epochStart,
            roundIntervalMs: oracle.roundInterval
        });
    }

    // Write-time half of the defence: refuse a round number the schedule
    // could not have produced. Returns null to accept, or the rejection reason.
    //
    // ONE-SIDED. Only the FUTURE side rejects, because only it is impossible:
    // replaying indexers, catching-up chain-only nodes and hour-wide batch
    // windows all legitimately push rounds that are hours or days old, and
    // bounding the past would drop real consensus output.
    _refuseOutOfBandRound(round, sourceChain, what) {
        let band = this._roundBand();
        if (!band || !roundBandLib.isRoundImplausible(round, band)) return null;
        this.implausibleRoundRejections += 1;
        this.lastImplausibleRound = Number(round);
        // Never silent: an out-of-band round is either a corrupt row upstream or a
        // peer with a broken clock, and both need naming rather than a quiet drop.
        console.warn('PriceAggregator: refusing ' + what + ' from ' +
                     (sourceChain || 'unknown') + ': ' +
                     roundBandLib.describeImplausibleRound(round, band));
        return 'implausible round';
    }

    // Name a pair that STOPPED arriving from a source chain. The PRODUCER path records a
    // durable 'skipped' row for every configured pair a finalized round omitted
    // (OracleConsensus._storeSnapshot, item #180) and getSubmissionsInfo surfaces those as
    // droppedPairs; this path had no equivalent, so on a mirror hub a pair that quietly
    // stopped appearing in pushed rounds left no row, no counter and no line naming it,
    // while consumers kept serving its previous round and the drop diagnostics read
    // healthy (item 5335).
    //
    // The reference set is the pairs THIS source chain has actually been sending, not this
    // hub's local pair config. Local config is the wrong basis on an ingest path: the round
    // is another federation's consensus output, so any pair it legitimately does not publish
    // (a gate not yet open there, a feed it cannot source, a version skew in its pair list)
    // would warn on every single round, and a detector that fires constantly names nothing.
    // A high-water set per chain self-calibrates instead: the first accepted round from a
    // chain only records what it carries, and only a pair that was arriving and then stops
    // is reported. The cost is that the set is in-memory, so a pair already gone before a
    // restart is not re-reported; that is the honest limit of a non-durable detector, and
    // the alternative (writing marker rows from local config) would put rows the source
    // chain never finalized into a consensus-MIRRORED table, its id-ordered bootstrap read
    // and its row:inserted stream, letting two hubs mirror one round differently.
    //
    // Warnings are throttled per source chain on the _warnIngestFenceRejection pattern: the
    // first short round prints immediately, then at most one line per window, carrying both
    // the count it stands for and the running total of short rounds so nothing is lost.
    _checkIngestPairCoverage(sourceChain, round, pairs) {
        let chain   = sourceChain || 'unknown';
        let present = new Set(pairs.map(p => p.pair));
        let state   = this._missingPairWarnState.get(chain);
        if (!state) {
            // First round from this chain: adopt its pair set as the baseline, report nothing.
            this._missingPairWarnState.set(chain, { seen: present, last: 0, suppressed: 0, rounds: 0 });
            return;
        }
        let missing = [...state.seen].filter(pair => !present.has(pair));
        // Grow the high-water set with anything new, so a pair that starts arriving is
        // covered from then on; a missing pair stays in `seen` so it keeps being reported
        // until it comes back.
        for (let pair of present) state.seen.add(pair);
        if (!missing.length) return;
        this._warnMissingIngestPairs(chain, round, missing, state);
    }

    _warnMissingIngestPairs(chain, round, missingPairs, state) {
        let now = Date.now();
        state.rounds++;
        if (state.last && (now - state.last) < MISSING_PAIR_WARN_INTERVAL_MS) {
            state.suppressed++;
            return;
        }
        let suppressed = state.suppressed;
        state.last = now;
        state.suppressed = 0;
        console.warn('PriceAggregator: round ' + round + ' from ' + chain + ' arrived without '
            + missingPairs.length + ' pair(s) this chain had been sending: ' + missingPairs.join(', ')
            + '. Consumers keep serving the previous round for each one until it returns.'
            + ' ' + state.rounds + ' round(s) from this chain have been short a pair so far'
            + (suppressed > 0 ? '; ' + suppressed + ' warning(s) suppressed since the last line' : '')
            + '. If a pair is gone for good, the source federation stopped publishing it;'
            + ' if it flaps, that federation is dropping it at its own aggregation gate.');
    }

    // An ingest-fence rejection must never be silent (a bare
    // { accepted:false } return), because a silent one kills a price rail: reset an
    // indexer DB and its push_generations counter restarts at 0, so every push from
    // it sits at or below a kept retraction_generation and is dropped. The operator
    // sees "prices stopped" with nothing anywhere naming the cause, and the
    // native-fee / XCHAIN-USD path that rides on prices fails with it.
    //
    // So say it out loud, with the remedy in the line: on this path the fence is far
    // more likely to be firing on a rebuilt indexer (a standing condition that stops
    // the rail until someone clears the row) than on the stale in-flight replay it
    // was built for (a one-off).
    //
    // Throttled per source chain because a replaying pusher must not be able to
    // flood the log: the first rejection prints immediately, then at most one line
    // per window, carrying the count it stands for so the volume is never lost.
    // The deployment network every fence read and write on this hub is scoped to. The fence
    // row is keyed (network, source_chain): without the network key, a hub DB shared by, or
    // outliving, more than one network holds ONE row per chain for all of them, so clearing
    // a regtest fence drops the live network's fence for that chain. A hub whose HUB_NETWORK is unset
    // keys the legacy '' bucket, which is exactly where its pre-column rows already are.
    // Normalized in the same shape as db.js normalizeFenceNetwork (trim + lowercase) rather
    // than by requiring db.js, which would pull the mariadb driver into this module's require
    // graph for a two-line string fold.
    _fenceNetwork() {
        let net = this.hub && this.hub.network;
        return typeof net === 'string' ? net.trim().toLowerCase() : '';
    }

    _warnIngestFenceRejection(sourceChain, kind, pushGeneration, actionIndex, wm) {
        let chain = sourceChain || 'unknown';
        let now   = Date.now();
        let state = this._fenceWarnState.get(chain);
        if (state && (now - state.last) < FENCE_WARN_INTERVAL_MS) {
            state.suppressed++;
            return;
        }
        let suppressed = state ? state.suppressed : 0;
        this._fenceWarnState.set(chain, { last: now, suppressed: 0 });
        console.warn('PriceAggregator: WARNING: DROPPED ' + kind + ' price push from ' + chain
            + ' at the ingest fence (push_generation ' + pushGeneration + ' <= retraction_generation '
            + wm.retraction_generation + ' AND action_index ' + actionIndex + ' >= from_action_index '
            + wm.from_action_index + ').'
            + (suppressed > 0 ? ' ' + suppressed + ' further rejection(s) for this chain were suppressed since the last warning.' : '')
            + ' The ' + chain + ' price rail is DOWN for as long as this repeats, and the native-fee'
            + ' / XCHAIN-USD path fails with it. If the ' + chain + ' indexer DB was reset or rebuilt,'
            + ' its push_generations counter restarted at 0 and this fence row is stale: clear it with'
            + " DELETE FROM price_ingest_watermarks WHERE source_chain = '" + chain + "'"
            + " AND network = '" + this._fenceNetwork() + "'"
            + ' on the hub DB. The network clause is what keeps the clear off every OTHER'
            + " network's fence for the same chain, so run it exactly as written."
            + ' Otherwise this is a stale replay of a retracted action and the'
            + ' drop is correct.');
    }

    // Build the canonical signable payload for a PRICE v0 round.
    // MUST match xchain-indexer/src/ed25519.js buildPriceV0Payload (and
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
    // several rounds. MUST match xchain-indexer/src/ed25519.js buildPriceBatchPayload and
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
    _buildPriceBatchPayload(firstRound, lastRound, btcBlockHeight, rounds) {
        let sortedRounds = [...rounds]
            .sort((a, b) => parseInt(a.round) - parseInt(b.round))
            .map(r => {
                let pairs = r.pairs.map(p => ({ pair: p.coinPair || p.pair, price: String(p.price) }));
                let sortedPairs = [...pairs].sort((a, b) => {
                    if (a.pair < b.pair) return -1;
                    if (a.pair > b.pair) return 1;
                    return 0;
                });
                return {
                    round:            parseInt(r.round),
                    timestamp:        parseInt(r.timestamp),
                    btc_block_height: parseInt(r.btcBlockHeight),
                    pairs:            sortedPairs
                };
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

    // The pusher's local validation is NOT trusted: before any row is stored
    // as 'finalized', every signature is re-verified here against the
    // canonical payload, signers must be in the price-capability validator
    // snapshot at block_index, and the verified count must meet PBFT quorum.
    // Returns: { accepted, reason } where reason explains the rejection
    async receiveValidatedRound(sourceChain, roundData) {
        if (!roundData || roundData.round === undefined || roundData.round === null || !Array.isArray(roundData.pairs) || roundData.pairs.length < 1) {
            return { accepted: false, reason: 'invalid roundData' };
        }

        let round = parseInt(roundData.round);
        if (!Number.isFinite(round) || round < 0) {
            return { accepted: false, reason: 'invalid round' };
        }

        // The round number must be one this hub's own schedule could have
        // produced. Checked BEFORE any signature work, since an out-of-band round is
        // refused whatever it is signed with.
        let bandReason = this._refuseOutOfBandRound(round, sourceChain, 'PRICE v0 round');
        if (bandReason) return { accepted: false, reason: bandReason };

        // timestamp is part of the signed payload; it must be present and sane
        let timestamp = parseInt(roundData.timestamp);
        if (!Number.isFinite(timestamp) || timestamp < 0) {
            return { accepted: false, reason: 'invalid timestamp' };
        }

        // block_index anchors both the signed payload's validator snapshot and
        // the stored reference_block; verification is impossible without it
        let referenceBlock = parseInt(roundData.block_index);
        if (!Number.isFinite(referenceBlock) || referenceBlock < 0) {
            return { accepted: false, reason: 'invalid block_index' };
        }

        // btc_block_height is the round's BTC anchor, part of the signed payload and
        // the on-chain PRICE v0 wire. It is what the EQUIV header gate keys on, so the
        // hub reconstructs identical bytes to what the validators signed (#4232). It is
        // distinct from block_index (the block the PRICE tx itself was mined in).
        let btcBlockHeight = parseInt(roundData.btc_block_height);
        if (!Number.isFinite(btcBlockHeight) || btcBlockHeight < 0) {
            return { accepted: false, reason: 'invalid btc_block_height' };
        }

        // Every pair must satisfy the on-chain wire-format rules (mirrors the
        // indexer's PRICE v0 parser) so the canonical payload reconstruction
        // below is byte-exact with what the validators signed.
        //
        // The pair-name bound is flag-day gated (price_pair_activation.js,
        // vendored byte-identically from the indexer): below it the ticker side caps
        // at 5 characters and the 6-character XCHAIN/USD pair is unrepresentable;
        // at/above it, 6 is accepted. UNARMED on mainnet today.
        //
        // KEYED ON THE ROUND TIMESTAMP, while the chain keys on the block time of the
        // block the PRICE tx landed in. The push payload carries no block time (see
        // actions/price.js), and the two are not equal: a round is stamped, then
        // mined, so block_time >= timestamp. That asymmetry is deliberate and is the
        // safe direction - the hub can only activate LATER than the chain, never
        // earlier, so it may briefly withhold on a round the chain accepted (one
        // round of carry-forward, self-healing) but can never finalize one the chain
        // will reject. If even that blip is unacceptable at arming time, the clean
        // fix is to add block_time to the hub-push payload and key on it here.
        let pairPattern = pricePair.pricePairPattern(timestamp, this.hub && this.hub.network);

        // The price-value flag day (price_scale_activation.js, vendored byte-identically
        // from the indexer) rides the SAME key as the pair bound above, so the hub can
        // never grade a price under a rule the chain is not yet applying. At/above it a
        // price is canonical: no leading zeros, at most 8 decimals, which is what every
        // producer already emits and what bounds the stored string to 19 characters,
        // inside the price column. UNARMED on mainnet today.
        let pricePattern = priceScale.priceValuePattern(timestamp, this.hub && this.hub.network);
        for (let p of roundData.pairs) {
            if (!p || typeof p.pair !== 'string' || !pairPattern.test(p.pair) ||
                p.price === undefined || p.price === null || !pricePattern.test(String(p.price)) ||
                // Enforce the consensus PRICE_MAX ceiling at ingest, as constants.js mandates
                // ("the ingestion layer must reject anything at or above it"); every other
                // price entry point already does, so the ingest/aggregate bounds cannot drift
                // apart and a Byzantine round cannot smuggle an at/above-PRICE_MAX pair past
                // ingest (item 9e6c0acd). The positive lower bound mirrors the
                // governance-path check below: a quorum-signed zero (or all-zero)
                // price must not pass ingest and finalize as a real price.
                !(parseFloat(String(p.price)) > 0) ||
                !(parseFloat(String(p.price)) < PRICE_MAX)) {
                return { accepted: false, reason: 'invalid pairs' };
            }
        }

        // Structural sig validation: [{ pubkey: 64-hex, sig: 128-hex }, ...]
        if (!Array.isArray(roundData.sigs) || roundData.sigs.length < 1) {
            return { accepted: false, reason: 'invalid sigs' };
        }
        let sigs = [];
        for (let s of roundData.sigs) {
            if (!s || typeof s.pubkey !== 'string' || typeof s.sig !== 'string' ||
                !/^[0-9a-fA-F]{64}$/.test(s.pubkey) || !/^[0-9a-fA-F]{128}$/.test(s.sig)) {
                return { accepted: false, reason: 'invalid sigs' };
            }
            sigs.push({ pubkey: s.pubkey.toLowerCase(), sig: s.sig.toLowerCase() });
        }

        // Dedupe: if a NON-SKIPPED row exists for this round_number, this is a
        // duplicate of an already-finalized round. 'skipped' placeholder rows
        // (written by OracleConsensus._storeSkippedRound when this hub had no
        // local submissions) must NOT count as a duplicate. A real validated
        // round for the same round_number can still arrive from a peer chain that
        // did reach quorum, and it must be allowed to overwrite the placeholders
        // (see the ON DUPLICATE KEY UPDATE on the insert below).
        let existing = await this.db.doQuery(
            "SELECT id FROM price_snapshots WHERE round_number = ? AND status != 'skipped' LIMIT 1",
            [round]
        );
        if (existing && existing.length > 0) {
            return { accepted: false, reason: 'duplicate' };
        }

        // STAKE_WEIGHTED_QUORUM: at/above activation the chain finalizes a PRICE v0 on the
        // summed STAKE of its qualified signers rather than their COUNT (actions/price.js).
        // This method is the hub's MIRROR of that same verification, not a producer, so it
        // has to switch on the identical key or hub and chain read one signed round under
        // two rules: the hub withholds on a round the chain finalized under stake weight
        // (fewer signatures than the count bar), or stores one the chain refused (many
        // small signers, insufficient distinct-source stake).
        //
        // Keyed on btcBlockHeight, the round's signed BTC anchor, which is exactly what the
        // indexer twin keys on. Keying on referenceBlock (the height of the chain the PRICE
        // landed on) would flip LTC/DOGE months early, their heights already dwarfing the
        // BTC activation height. Unlike the pair-name gate above there is no
        // timestamp-vs-block-time asymmetry to accept: btc_block_height rides in the push
        // payload and is validated at the top of this method, so hub and chain evaluate the
        // same number and cannot straddle the flag day. Hub and indexer are PEERS here:
        // deploy both before the activation height.
        //
        // The snapshot BLOCK stays referenceBlock in both modes. The twin resolves its
        // weights at the PRICE's own BLOCK_INDEX, so moving this key would trade one
        // divergence for another.
        let weighted = swq.isStakeWeightedQuorumActive(btcBlockHeight, this.hub && this.hub.network);

        // Resolve the deterministic price-capability validator set at the
        // round's block. Fail closed: without the snapshot the sigs cannot be
        // checked against the qualified set, so the round is rejected rather
        // than stored on trust. A weight snapshot the hub cannot resolve rejects
        // too and never falls back to the count quorum: unlike OracleConsensus
        // (a producer, which may skip a round) this is the verifier, and
        // downgrading its threshold locally would accept rounds the chain rejects.
        let capSnap  = this.hub.capabilitySnapshot;
        let snapshot = null;
        if (capSnap) {
            snapshot = weighted
                ? (typeof capSnap.getWeightSnapshot === 'function'
                    ? await capSnap.getWeightSnapshot('price', referenceBlock)
                    : null)
                : await capSnap.getSnapshot('price', referenceBlock);
        }
        if (!snapshot || !Array.isArray(snapshot.validators)) {
            return { accepted: false, reason: 'validator snapshot unavailable' };
        }
        // SWQ-TRUNC parity: a truncated weight snapshot has silently-dropped sources, so
        // its total stake S is under-counted and the strict 2/3 bar could pass a round the
        // full set would refuse. meetsStakeThreshold fails closed on the flag, but reads it
        // off the validators ARRAY while getWeightSnapshot carries it on the snapshot, so
        // refuse here rather than relying on a flag that would never arrive.
        if (weighted && snapshot.truncated === true) {
            return { accepted: false, reason: 'validator snapshot truncated' };
        }

        // Verify each sig over the canonical payload, counting at most one per
        // qualified pubkey. Unknown or invalid sigs are skipped rather than
        // fatal (same semantics as the indexer's PRICE v0 parser), so any
        // round the indexer accepted on-chain also verifies here, but only
        // cryptographically-valid sigs from snapshot members count for quorum.
        // The admission map comes off the pushed round, because the producer signed THAT
        // map and a map re-resolved from this hub's own tips would rebuild bytes no
        // signature covers. An absent map is the legacy round. A map the canonical encoder
        // refuses is a REJECTED push and never a thrown request: the era gate and the
        // spelling rules both report through this reason, so an operator sees which round
        // was refused instead of a 500 on the ingest path.
        let payload;
        try {
            payload = this._buildPriceV0Payload(round, timestamp, roundData.pairs, btcBlockHeight,
                                                roundData.admit_blocks);
        } catch (e) {
            return { accepted: false, reason: 'admission map unusable: ' + e.message };
        }
        let qualified  = new Set(snapshot.validators.map(v => String(v.pubkey).toLowerCase()));
        let seenPubkey = new Set();
        let verifiedSigs = [];

        // PRICE_SIG_TALLY: WHERE the pubkey enters the dedupe set. At/above
        // the gate it enters only after a successful verify, so a garbage signature
        // carrying a qualified oracle's pubkey cannot be ordered ahead of that
        // oracle's real one to consume its slot and under-count the round. Below the
        // gate the legacy mark-on-first-encounter ordering is preserved verbatim.
        // Either way a pubkey counts AT MOST ONCE.
        //
        // Keyed on btcBlockHeight, the round's signed BTC anchor, which is EXACTLY
        // what the indexer twin keys on (actions/price.js). Unlike the pair-name gate
        // above there is no timestamp-vs-block-time asymmetry to accept here: the push
        // payload carries btc_block_height and it is validated at the top of this
        // method, so the hub and the chain evaluate the identical number and can never
        // straddle the flag-day. Hub and indexer are PEERS across this gate, not
        // producer and consumer: deploy both before the activation height, or the hub
        // finalizes rounds the chain rejects (or withholds on rounds it accepts).
        let verifyFirst = priceSigTally.isPriceSigTallyVerifyFirstActive(
            btcBlockHeight, this.hub && this.hub.network);

        for (let s of sigs) {
            if (seenPubkey.has(s.pubkey)) continue;        // duplicate pubkey counts once
            if (!verifyFirst) seenPubkey.add(s.pubkey);
            if (!qualified.has(s.pubkey)) continue;        // not price-qualified at this block
            if (!ValidatorIdentity.verify(payload, s.sig, s.pubkey)) continue;
            if (verifyFirst) seenPubkey.add(s.pubkey);
            verifiedSigs.push(s);
        }

        // Finalization threshold, in whichever mode the flag day above selected. Both
        // branches are the same threshold the indexer enforces when validating the
        // action, which is the whole point of the gate: at/above activation it tallies
        // the summed source-deduped STAKE of the verified signers (3*tally > 2*S), below
        // it the PBFT quorum over the snapshot size, floored at a simple majority
        // (max(2 * floor((N - 1) / 3) + 1, ceil((N + 1) / 2))).
        if (weighted) {
            // Tallied over the verified signer PUBKEYS, the same set the twin passes as
            // qualifiedSigners. meetsStakeThreshold source-dedupes internally, so a source
            // that signed with several keys counts once.
            if (!swq.meetsStakeThreshold(snapshot.validators, verifiedSigs.map(s => s.pubkey))) {
                return { accepted: false, reason: 'insufficient signer stake (' + verifiedSigs.length + ' verified signers)' };
            }
        } else {
            let setSize = Number.isFinite(parseInt(snapshot.count)) ? parseInt(snapshot.count) : snapshot.validators.length;
            let quorum  = bftQuorumOrSingle(setSize, 1);   // majority-floored BFT quorum
            if (verifiedSigs.length < quorum) {
                return { accepted: false, reason: 'insufficient quorum (' + verifiedSigs.length + '/' + quorum + ')' };
            }
        }

        // Only the verified signatures are stored as the consensus proof
        let proofJson = JSON.stringify(verifiedSigs);
        let validatorCount = verifiedSigs.length;
        let sourceActionIndex = roundData.action_index || null;
        // Source-chain reorg fence (item 5308): the generation the source indexer
        // carried on this push. Stamped on the row so a later deferred retraction
        // (which carries the rollback's generation) deletes only stale rows and a
        // re-published row at a recycled action_index (higher generation) survives.
        let pushGeneration = parseInt(roundData.push_generation);
        if (!Number.isFinite(pushGeneration) || pushGeneration < 0) pushGeneration = 0;

        // HUB-RETRACT-4: same stale-replay ingest fence as receiveOraclePrice. A PBFT round push
        // that arrives after its source action was rolled back and retracted (carrying the pre-reorg
        // generation) is rejected; the re-published canonical round carries a higher generation. No
        // action_index (older sender) => no fence, as before.
        let roundActionIndex = parseInt(sourceActionIndex);
        if (Number.isFinite(roundActionIndex)) {
            let wm = await this.db.getPriceIngestWatermark(sourceChain || '', this._fenceNetwork());
            if (wm && pushGeneration <= wm.retraction_generation && roundActionIndex >= wm.from_action_index) {
                // Never silent: a rebuilt indexer trips this fence on every push.
                this._warnIngestFenceRejection(sourceChain, 'PRICE v0 round', pushGeneration, roundActionIndex, wm);
                return { accepted: false, reason: 'stale (retracted generation)' };
            }
        }

        // Capture a single hub-side timestamp before the loop so all pairs in this round
        // share the same created_at and it propagates to operators via the WS broadcast row.
        let createdAt = new Date();
        let insertedRows = [];
        // Upsert (not a plain INSERT): a 'skipped' placeholder row may already occupy
        // this (round_number, coin_pair) unique key from _storeSkippedRound. Overwrite
        // it with the real finalized data rather than colliding on the key. For an
        // already-finalized row this is an idempotent no-op of identical data (failover
        // double-publish safe). created_at is intentionally NOT overwritten so it
        // preserves when the hub first recorded the round.
        //
        // ONE multi-row INSERT lands the whole round atomically; a getfeequote /
        // getpricesnapshots reader (or the id-ordered mirror bootstrap) can never observe
        // a torn round (some pairs from this round, others from the prior round). The hub
        // Database has no transaction API, so a single statement is the atomicity tool.
        if (roundData.pairs.length) {
            let placeholders = roundData.pairs.map(() => "(?, ?, ?, ?, ?, ?, ?, 1, ?, 'finalized', ?, ?, ?, ?)").join(', ');
            let params = [];
            for (let p of roundData.pairs) {
                params.push(round, p.pair, p.price, referenceBlock, sourceChain || null, timestamp,
                            validatorCount, proofJson, sourceChain || null, sourceActionIndex, pushGeneration, createdAt);
                insertedRows.push({
                    round_number:        round,
                    coin_pair:           p.pair,
                    price:               p.price,
                    reference_block:     referenceBlock,
                    reference_chain:     sourceChain || null,
                    block_timestamp:     timestamp,
                    validator_count:     validatorCount,
                    consensus_round:     1,
                    consensus_proof:     proofJson,
                    status:              'finalized',
                    source_chain:        sourceChain || null,
                    source_action_index: sourceActionIndex,
                    push_generation:     pushGeneration,
                    created_at:          createdAt
                });
            }
            let query = `INSERT INTO price_snapshots
                (round_number, coin_pair, price, reference_block, reference_chain, block_timestamp,
                 validator_count, consensus_round, consensus_proof, status, source_chain, source_action_index,
                 push_generation, created_at)
                VALUES ${placeholders}
                ON DUPLICATE KEY UPDATE
                    price = VALUES(price), reference_block = VALUES(reference_block),
                    reference_chain = VALUES(reference_chain), block_timestamp = VALUES(block_timestamp),
                    validator_count = VALUES(validator_count), consensus_proof = VALUES(consensus_proof),
                    status = 'finalized', source_chain = VALUES(source_chain),
                    source_action_index = VALUES(source_action_index),
                    push_generation = VALUES(push_generation)`;
            try {
                await this.db.doQuery(query, params);
            } catch (err) {
                console.error('PriceAggregator: error inserting round ' + round + ':', err);
                return { accepted: false, reason: 'db error' };
            }
        }

        // Emit row events so the hub DB sync channel can broadcast to subscribers
        for (let row of insertedRows) {
            this.emit('row:inserted', { table: 'price_snapshots', row: row });
        }

        console.log('PriceAggregator: accepted round ' + round + ' from ' + (sourceChain || 'unknown') + ' (' + roundData.pairs.length + ' pairs, ' + validatorCount + ' sigs)');

        // Per-pair coverage check (item 5335): name any pair this chain had been sending and
        // this round did not carry, so an ingest hub's silent pair drop is as visible as the
        // producer path's droppedPairs. Diagnostics only, and guarded: the round is already
        // stored and must never be flipped to rejected by a coverage warning.
        try {
            this._checkIngestPairCoverage(sourceChain, round, roundData.pairs);
        } catch (e) {
            console.warn('PriceAggregator: pair-coverage check failed for round ' + round + ':', e.message);
        }

        return { accepted: true };
    }

    // Stamp the LANDING clock of the batch that carried `round` onto rows of that
    // round which are already finalized here, and re-emit whatever it changed so every
    // mirror following this hub converges on the same value.
    //
    // EARLIEST LANDING WINS. Overlapping and re-published batches carry the same rounds
    // by design (D25), so taking the minimum makes the stored clock independent of the
    // order a hub happened to receive them in; two hubs that saw the same chain end up
    // bounding fee pricing identically, which is the whole point of the column.
    //
    // Returns the number of rows re-emitted (0 when an earlier batch already stamped
    // the round at or below this clock).
    async _stampBatchLanding(round, blockTime) {
        let landed = Number(blockTime);
        if (!Number.isSafeInteger(landed) || landed <= 0) return 0;
        try {
            await this.db.doQuery(
                "UPDATE price_snapshots SET batch_block_time = ? WHERE round_number = ? " +
                "AND status != 'skipped' AND (batch_block_time = 0 OR batch_block_time > ?)",
                [landed, round, landed]
            );
            // Re-read rather than trust an affected-row count: the mirror applier is an
            // upsert keyed on (round_number, coin_pair), so it needs the WHOLE row, and
            // selecting the rows that now carry THIS clock also skips the no-op case
            // without asking the driver for a count it does not uniformly report.
            let rows = await this.db.doQuery(
                'SELECT round_number, coin_pair, price, reference_block, reference_chain, block_timestamp, ' +
                'validator_count, consensus_round, consensus_proof, status, source_chain, source_action_index, ' +
                'push_generation, batch_block_time, created_at FROM price_snapshots ' +
                'WHERE round_number = ? AND batch_block_time = ?',
                [round, landed]
            );
            for (let row of (rows || [])) {
                this.emit('row:inserted', { table: 'price_snapshots', row: row });
            }
            return (rows || []).length;
        } catch (err) {
            // Never fatal: the round is finalized either way, and an unstamped round
            // reads as NOT LANDED, which fails fee pricing closed rather than pricing
            // against a round the chain has not shown. Loud, because a hub that cannot
            // stamp holds the fee gate shut for its own indexers once the bound is armed.
            console.error('PriceAggregator: could not stamp the landing clock for round ' +
                round + ':', err);
            return 0;
        }
    }

    // PRICE v0 (batch) ingest: ONE quorum signature set over a WINDOW of full-body
    // rounds. Same posture as receiveValidatedRound (the pusher's local validation is
    // never trusted; every signature is re-verified here against the canonical bytes
    // the validators signed), with the two differences the batch shape forces:
    //
    //   - the signature set is verified ONCE, because it covers every round in the
    //     window. A signature or structural failure therefore rejects the WHOLE batch,
    //     exactly as it rejects a whole round in v0: a signed batch is atomic.
    //   - dedupe is PER ROUND, not the whole-call early return receiveValidatedRound
    //     uses. Overlapping and re-published batches are expected (leaders may split a
    //     window differently, D25), so a whole-call return over one already-finalized
    //     round would silently drop the five good rounds sharing the batch, and under
    //     batching the batch is the SOLE carrier of those rounds for a chain-only node.
    //
    // Returns { accepted, stored, duplicates, rejected } (D13). `accepted` is true iff
    // every round either stored or deduped; `reason` names the cause when it is not.
    async receiveValidatedBatch(sourceChain, batchData) {
        let roundCount = (batchData && Array.isArray(batchData.rounds)) ? batchData.rounds.length : 0;
        // Whole-batch rejection: nothing stored, nothing deduped, every round refused.
        let refuse = (reason) => ({ accepted: false, stored: 0, duplicates: 0, rejected: roundCount, reason });

        if (!batchData || !Array.isArray(batchData.rounds) || batchData.rounds.length < 1) {
            return refuse('invalid batchData');
        }
        // DoS bound, mirroring the wire parser's own (D15): the round count rides in
        // from an external pusher and every round below costs a dedupe SELECT plus an
        // INSERT. The wire ceiling already makes a larger batch physically impossible.
        if (batchData.rounds.length > PRICE_BATCH_MAX_ROUND_COUNT) {
            return refuse('too many rounds');
        }

        let firstRound = parseInt(batchData.first_round);
        let lastRound  = parseInt(batchData.last_round);
        if (!Number.isFinite(firstRound) || firstRound < 0 ||
            !Number.isFinite(lastRound)  || lastRound  < 0 || firstRound > lastRound) {
            return refuse('invalid round window');
        }

        // Batch twin. Judged on lastRound alone: the per-round loop below
        // already refuses any round outside [firstRound, lastRound], so the window's
        // top bounds every round the batch can carry. A signed batch is atomic, so an
        // out-of-band round takes the whole batch down rather than being dropped from it.
        let bandReason = this._refuseOutOfBandRound(lastRound, sourceChain, 'PRICE v0 batch');
        if (bandReason) return refuse(bandReason);

        // The BATCH anchor: part of the signed canonical, and the height every oracle
        // flag day below resolves on (§5.5). Distinct from each round's own anchor.
        let btcBlockHeight = parseInt(batchData.btc_block_height);
        if (!Number.isFinite(btcBlockHeight) || btcBlockHeight < 0) {
            return refuse('invalid btc_block_height');
        }

        // block_index is the LANDING block on the landing chain, and it is what the
        // stored reference_block records (D8). It is NOT what the validator snapshot
        // resolves on; see the snapshot read below.
        let referenceBlock = parseInt(batchData.block_index);
        if (!Number.isFinite(referenceBlock) || referenceBlock < 0) {
            return refuse('invalid block_index');
        }

        // block_time is the landing block's own clock, and it is why the batch push
        // carries a field the v0 push does not (D14). The pair-name flag day is keyed
        // on it below; digits-only and inside the safe-integer range, on the same
        // reasoning receiveOraclePrice records for its own block_time gate (parseInt
        // rounds silently past 2^53, and a coerced 0 would read as "before every flag
        // day" on a genesis-on network).
        if (!/^[0-9]+$/.test(String(batchData.block_time)) ||
            !Number.isSafeInteger(Number(batchData.block_time)) ||
            Number(batchData.block_time) <= 0) {
            return refuse('invalid block_time');
        }
        let blockTime = parseInt(batchData.block_time, 10);

        // THE PAIR-NAME FLAG DAY IS KEYED ON THE BATCH'S block_time, NOT on each
        // round's own timestamp as v0 keys it (D14). v0 has no block time in its push
        // payload and accepts the resulting skew because it is one-sided and small: a
        // round is stamped, then mined, so block_time >= timestamp and the hub can only
        // activate LATER than the chain (one round of carry-forward, self-healing). A
        // batch widens that skew from ~10 minutes to ~70, so keying this gate on a
        // round timestamp would have the hub refuse a whole HOUR the chain accepted.
        // Carrying block_time and keying on it is the clean fix the
        // comment in receiveValidatedRound already names. One pattern for the whole
        // batch, because every round in it landed in the same block.
        let pairPattern = pricePair.pricePairPattern(blockTime, this.hub && this.hub.network);

        // The price-value flag day, keyed on the batch's block_time for the same reason
        // the pair bound is: one pattern for the whole batch, because every round in it
        // landed in the same block, and no window can straddle this gate.
        let pricePattern = priceScale.priceValuePattern(blockTime, this.hub && this.hub.network);

        // Per-round structure. Rounds must be strictly ascending, unique and inside the
        // declared window (D16); the window is validated for shape, deliberately NOT
        // against the publisher's window-size knob, so validation stays range-agnostic.
        let rounds  = [];
        let prev    = null;
        for (let r of batchData.rounds) {
            if (!r || !Array.isArray(r.pairs) || r.pairs.length < 1) return refuse('invalid rounds');
            let round = parseInt(r.round);
            if (!Number.isFinite(round) || round < 0)               return refuse('invalid rounds');
            if (round < firstRound || round > lastRound)            return refuse('round outside window');
            if (prev !== null && round <= prev)                     return refuse('rounds not strictly ascending');
            prev = round;

            let timestamp = parseInt(r.timestamp);
            if (!Number.isFinite(timestamp) || timestamp < 0)       return refuse('invalid round timestamp');
            let roundAnchor = parseInt(r.btc_block_height);
            if (!Number.isFinite(roundAnchor) || roundAnchor < 0)   return refuse('invalid round btc_block_height');

            // Identical pair rules to v0 (wire-format parity, PRICE_MAX ceiling and the
            // positive lower bound), so a batch cannot smuggle past ingest a pair a
            // single-round push would be refused for.
            for (let p of r.pairs) {
                if (!p || typeof p.pair !== 'string' || !pairPattern.test(p.pair) ||
                    p.price === undefined || p.price === null || !pricePattern.test(String(p.price)) ||
                    !(parseFloat(String(p.price)) > 0) ||
                    !(parseFloat(String(p.price)) < PRICE_MAX)) {
                    return refuse('invalid pairs');
                }
            }
            rounds.push({ round, timestamp, btcBlockHeight: roundAnchor, pairs: r.pairs });
        }

        // THE HEADER ANCHOR IS CONSTRAINED TO THE LAST ROUND'S OWN ANCHOR (§4), the twin
        // of the indexer parser's structural check. Both quorum gates below resolve on
        // this one value and the straddle rule inspects only the per-round anchors, so an
        // unconstrained header would let a colluding signing quorum pick which consensus
        // rule judges its own batch while every per-round anchor stayed honest. The rounds
        // are strictly ascending by the loop above, so the last one carries the window's
        // highest anchor. Checked BEFORE the gates read it, or it protects nothing.
        if (btcBlockHeight !== rounds[rounds.length - 1].btcBlockHeight) {
            return refuse('batch anchor does not match the last round');
        }

        let network = this.hub && this.hub.network;

        // STRADDLE RULE (D7 / §5.4): a batch resolves the oracle flag days ONCE, on the
        // batch anchor, so a window whose first and last rounds sit on opposite sides of
        // an armed gate would judge its earlier rounds under the later rule. Such a batch
        // is invalid on-chain and the publisher never assembles one; refusing it here
        // keeps the hub from storing rounds the chain rejected.
        let firstAnchor = rounds[0].btcBlockHeight;
        let lastAnchor  = rounds[rounds.length - 1].btcBlockHeight;
        if (priceSigTally.isPriceSigTallyVerifyFirstActive(firstAnchor, network) !==
            priceSigTally.isPriceSigTallyVerifyFirstActive(lastAnchor, network) ||
            swq.isStakeWeightedQuorumActive(firstAnchor, network) !==
            swq.isStakeWeightedQuorumActive(lastAnchor, network)) {
            return refuse('batch straddles an oracle flag day');
        }

        // ADMISSION ERA, FAIL CLOSED. The v0 ROUND canonical carries the round's admission
        // map and refuses in both directions, so a single-round push above the activation
        // either carries the producer's signed map or is rejected. THE BATCH CANONICAL
        // CARRIES NO SUCH FIELD: _buildPriceBatchPayload serializes only
        // {round, timestamp, btc_block_height, pairs} per round, so an admission map cannot
        // ride a batch and nothing a batch carries could be verified against a signature if
        // it did. Without this check an admission-era batch VERIFIES and stores its rounds
        // with no admission height at all, i.e. as legacy rows, silently, above the very
        // activation that is supposed to bind them by height. That is the fail-OPEN
        // direction and the one this design may never take.
        //
        // Judged on the batch anchor, which the check above has already constrained to the
        // LAST round's own anchor; the rounds are strictly ascending, so no round in the
        // batch is in the admission era unless this one is. A signed batch is atomic, so
        // the whole batch is refused rather than the era rounds dropped from it.
        //
        // When the batch canonical gains the per-round admission field (a three-way byte
        // twin: this builder, OracleConsensus._buildPriceBatchPayload and the indexer's
        // ed25519.buildPriceBatchPayload), this becomes "refuse an admission-era batch whose
        // rounds carry NO map" and keeps firing for exactly the rows it fires for today.
        if (ah.isAdmissionEra(network, btcBlockHeight)) {
            // Never silent: this refuses every batch on the rail once the activation arms,
            // and an operator reading only "rejected" would hunt a signature bug.
            console.warn('PriceAggregator: refusing PRICE batch [' + firstRound + '..' + lastRound +
                '] at anchor ' + btcBlockHeight + ' on ' + String(network) + ': the batch is in the ' +
                'admission era and the batch canonical has no wire carrier for the admission map, ' +
                'so its rounds could only be stored as legacy rows above the activation.');
            return refuse('admission-era batch: the batch canonical carries no admission map');
        }

        // Structural sig validation: [{ pubkey: 64-hex, sig: 128-hex }, ...]
        if (!Array.isArray(batchData.sigs) || batchData.sigs.length < 1) {
            return refuse('invalid sigs');
        }
        let sigs = [];
        for (let s of batchData.sigs) {
            if (!s || typeof s.pubkey !== 'string' || typeof s.sig !== 'string' ||
                !/^[0-9a-fA-F]{64}$/.test(s.pubkey) || !/^[0-9a-fA-F]{128}$/.test(s.sig)) {
                return refuse('invalid sigs');
            }
            sigs.push({ pubkey: s.pubkey.toLowerCase(), sig: s.sig.toLowerCase() });
        }

        // Source-chain reorg fence (item 5308 / HUB-RETRACT-4), same as the v0 path: a
        // batch push that arrives after its source action was rolled back and retracted
        // carries the pre-reorg generation and is dropped; the re-published canonical
        // batch carries a higher one. Checked before any verification work.
        let sourceActionIndex = batchData.action_index === undefined || batchData.action_index === null
            ? null : batchData.action_index;
        let pushGeneration = parseInt(batchData.push_generation);
        if (!Number.isFinite(pushGeneration) || pushGeneration < 0) pushGeneration = 0;
        let batchActionIndex = parseInt(sourceActionIndex);
        if (Number.isFinite(batchActionIndex)) {
            let wm = await this.db.getPriceIngestWatermark(sourceChain || '', this._fenceNetwork());
            if (wm && pushGeneration <= wm.retraction_generation && batchActionIndex >= wm.from_action_index) {
                // Never silent: a rebuilt indexer trips this fence on every push.
                this._warnIngestFenceRejection(sourceChain, 'PRICE batch', pushGeneration, batchActionIndex, wm);
                return refuse('stale (retracted generation)');
            }
        }

        // Both quorum gates resolve on the BATCH anchor, which is what the indexer twin
        // keys on for a batch action, and the straddle rule above is what makes one
        // resolution sound for every round in the window.
        let weighted = swq.isStakeWeightedQuorumActive(btcBlockHeight, network);

        // THE VALIDATOR SNAPSHOT RESOLVES ON THE BATCH'S SIGNED BTC ANCHOR, NOT ON THE
        // LANDING BLOCK. Capability staking lives only on Bitcoin, so the qualifying set
        // is BTC-anchored everywhere: the hub reads it from the BTC indexer at a BTC
        // height, and the indexer twin reads the mirrored capability_snapshots whose
        // snapshot_block IS a BTC height. Keying this on block_index made the two agree
        // only on Bitcoin, where the landing block IS the BTC block. Off Bitcoin a
        // Dogecoin or Litecoin height names no BTC block at all, the read resolved
        // nothing, and every batch a four-validator federation signed and landed on
        // chain was refused here as 'validator snapshot unavailable' while the chain
        // had accepted it. A hub keyed differently from the chain silently drops an
        // hour of rounds the chain finalized, and under batching this action is the
        // sole carrier of those rounds.
        //
        // The reorg buffer CapabilitySnapshot subtracts before resolving keeps meaning
        // what it always meant, and only now means it off Bitcoin too: it buries a BTC
        // height by BTC confirmations, rather than subtracting six landing-chain blocks
        // from a number that was never a BTC height.
        let capSnap  = this.hub.capabilitySnapshot;
        let snapshot = null;
        if (capSnap) {
            snapshot = weighted
                ? (typeof capSnap.getWeightSnapshot === 'function'
                    ? await capSnap.getWeightSnapshot('price', btcBlockHeight)
                    : null)
                : await capSnap.getSnapshot('price', btcBlockHeight);
        }
        // Fail closed: without the snapshot the sigs cannot be checked against the
        // qualified set, so the batch is refused rather than stored on trust.
        if (!snapshot || !Array.isArray(snapshot.validators)) {
            return refuse('validator snapshot unavailable');
        }
        // SWQ-TRUNC parity (see receiveValidatedRound): a truncated weight snapshot
        // under-counts total stake, so the strict 2/3 bar could pass a batch the full
        // set would refuse.
        if (weighted && snapshot.truncated === true) {
            return refuse('validator snapshot truncated');
        }

        // ONE verification pass over the batch canonical. _buildPriceBatchPayload is the
        // byte-for-byte twin of the indexer's and OracleConsensus's builders; never
        // inline the JSON here, or the three copies drift and every honest batch fails.
        let payload      = this._buildPriceBatchPayload(firstRound, lastRound, btcBlockHeight, rounds);
        let qualified    = new Set(snapshot.validators.map(v => String(v.pubkey).toLowerCase()));
        let seenPubkey   = new Set();
        let verifiedSigs = [];
        let verifyFirst  = priceSigTally.isPriceSigTallyVerifyFirstActive(btcBlockHeight, network);

        for (let s of sigs) {
            if (seenPubkey.has(s.pubkey)) continue;        // duplicate pubkey counts once
            if (!verifyFirst) seenPubkey.add(s.pubkey);
            if (!qualified.has(s.pubkey)) continue;        // not price-qualified at this block
            if (!ValidatorIdentity.verify(payload, s.sig, s.pubkey)) continue;
            if (verifyFirst) seenPubkey.add(s.pubkey);
            verifiedSigs.push(s);
        }

        if (weighted) {
            if (!swq.meetsStakeThreshold(snapshot.validators, verifiedSigs.map(s => s.pubkey))) {
                return refuse('insufficient signer stake (' + verifiedSigs.length + ' verified signers)');
            }
        } else {
            let setSize = Number.isFinite(parseInt(snapshot.count)) ? parseInt(snapshot.count) : snapshot.validators.length;
            let quorum  = bftQuorumOrSingle(setSize, 1);   // majority-floored BFT quorum
            if (verifiedSigs.length < quorum) {
                return refuse('insufficient quorum (' + verifiedSigs.length + '/' + quorum + ')');
            }
        }

        // Batch consensus proof (D23). Key order is PINNED: the acceptance test compares
        // this serialized value across a replaying node and a live one, so a reordering
        // here would read as a mismatch even with identical content. The `batch` object
        // is also what tells a batch-sourced row from a v0-sourced one, whose proof is a
        // bare signature ARRAY; retractFromActionIndex relies on that.
        let proofJson = JSON.stringify({
            batch: {
                first_round:      firstRound,
                last_round:       lastRound,
                btc_block_height: btcBlockHeight
            },
            sigs: verifiedSigs
        });
        let validatorCount = verifiedSigs.length;
        let createdAt = new Date();

        let stored = 0, duplicates = 0;
        for (let r of rounds) {
            // PER-ROUND dedupe (D13). A non-'skipped' row for this round_number means the
            // round is already finalized, from a v0 push, an earlier overlapping batch or a
            // failover double-publish; that round is a duplicate and the REST of the batch
            // still lands. 'skipped' placeholder rows are not duplicates and are overwritten
            // by the upsert below, exactly as on the v0 path.
            let existing = await this.db.doQuery(
                "SELECT id FROM price_snapshots WHERE round_number = ? AND status != 'skipped' LIMIT 1",
                [r.round]
            );
            if (existing && existing.length > 0) {
                duplicates++;
                // The round is already finalized HERE, but this batch is how the round
                // reached the CHAIN, and the landing clock is what fee pricing bounds
                // itself on once that gate is armed. On a validator every round of its
                // own batch takes this branch (it finalized them all itself), so
                // stamping only the stored rows would leave the one node kind that
                // produces rounds unable to tell a landed round from an unlanded one.
                await this._stampBatchLanding(r.round, blockTime);
                continue;
            }

            // Column semantics pinned so a v2-sourced row is indistinguishable from a
            // v0-sourced one (§5.7): block_timestamp is the ROUND's own timestamp (the
            // field the fee path reads), and reference_block is the PUSH's block_index,
            // the landing block on the landing chain (D8), NOT the round's BTC anchor.
            // Two consensus readers read reference_block, so a v2 row that differed here
            // would fork them.
            //
            // batch_block_time is the LANDING BLOCK's own clock, and it is a different
            // quantity from every other time column here: block_timestamp is when the
            // round was priced, this is when the chain could first show it. Fee pricing
            // bounds itself on it so a hub-connected node and a chain-only node select
            // the same round (price_fee_batch_landed_activation.js in the indexer).
            let insertedRows = [];
            let placeholders = r.pairs.map(() => "(?, ?, ?, ?, ?, ?, ?, 1, ?, 'finalized', ?, ?, ?, ?, ?)").join(', ');
            let params = [];
            for (let p of r.pairs) {
                params.push(r.round, p.pair, p.price, referenceBlock, sourceChain || null, r.timestamp,
                            validatorCount, proofJson, sourceChain || null, sourceActionIndex, pushGeneration,
                            blockTime, createdAt);
                insertedRows.push({
                    round_number:        r.round,
                    coin_pair:           p.pair,
                    price:               p.price,
                    reference_block:     referenceBlock,
                    reference_chain:     sourceChain || null,
                    block_timestamp:     r.timestamp,
                    validator_count:     validatorCount,
                    consensus_round:     1,
                    consensus_proof:     proofJson,
                    status:              'finalized',
                    source_chain:        sourceChain || null,
                    source_action_index: sourceActionIndex,
                    push_generation:     pushGeneration,
                    batch_block_time:    blockTime,
                    created_at:          createdAt
                });
            }
            // ONE multi-row INSERT PER ROUND, not one for the whole batch: the hub
            // Database has no transaction API, so a single statement is the atomicity
            // tool, and the unit that must never be observed torn is the round (a
            // getfeequote reader must not see some pairs of round N beside others of
            // round N-1). Across rounds a partial batch is fine, because each stored
            // round is independently complete and the rest arrive on the next attempt.
            let query = `INSERT INTO price_snapshots
                (round_number, coin_pair, price, reference_block, reference_chain, block_timestamp,
                 validator_count, consensus_round, consensus_proof, status, source_chain, source_action_index,
                 push_generation, batch_block_time, created_at)
                VALUES ${placeholders}
                ON DUPLICATE KEY UPDATE
                    price = VALUES(price), reference_block = VALUES(reference_block),
                    reference_chain = VALUES(reference_chain), block_timestamp = VALUES(block_timestamp),
                    validator_count = VALUES(validator_count), consensus_proof = VALUES(consensus_proof),
                    status = 'finalized', source_chain = VALUES(source_chain),
                    source_action_index = VALUES(source_action_index),
                    push_generation = VALUES(push_generation),
                    batch_block_time = IF(batch_block_time = 0 OR VALUES(batch_block_time) < batch_block_time,
                                          VALUES(batch_block_time), batch_block_time)`;
            try {
                await this.db.doQuery(query, params);
            } catch (err) {
                console.error('PriceAggregator: error inserting batch round ' + r.round + ':', err);
                return {
                    accepted: false, stored, duplicates,
                    rejected: rounds.length - stored - duplicates,
                    reason: 'db error'
                };
            }

            // Re-emit on the WS mirror stream exactly as v0-stored rows do, or a
            // replaying node's mirror never fills and its price barrier never opens.
            for (let row of insertedRows) {
                this.emit('row:inserted', { table: 'price_snapshots', row: row });
            }
            stored++;

            // Diagnostics only, and guarded: the round is already stored and must never
            // be flipped to rejected by a coverage warning (item 5335).
            try {
                this._checkIngestPairCoverage(sourceChain, r.round, r.pairs);
            } catch (e) {
                console.warn('PriceAggregator: pair-coverage check failed for round ' + r.round + ':', e.message);
            }
        }

        console.log('PriceAggregator: accepted batch [' + firstRound + '..' + lastRound + '] from '
            + (sourceChain || 'unknown') + ' (' + stored + ' stored, ' + duplicates + ' duplicate round(s), '
            + validatorCount + ' sigs)');

        // Tell the batch rail these rounds are on chain, WHETHER OR NOT any row was
        // stored. On a validator every round is normally a duplicate here (it finalized
        // them itself), so the stored rows the publisher's observation prune keys on
        // never appear, and its buffer kept every round it ever finalized until the
        // catch-up sweep re-published them as duplicates. The batch header is
        // the chain-derived range and this push reaches every hub, so it is the one
        // place a follower learns that a window it did not lead has landed.
        let landedPublisher = this.hub && this.hub.oraclePublisher;
        if (landedPublisher && typeof landedPublisher.noteBatchLanded === 'function') {
            try {
                landedPublisher.noteBatchLanded(firstRound, lastRound,
                    { sourceChain: sourceChain, actionIndex: batchData.action_index });
            } catch (e) {
                console.warn('PriceAggregator: could not hand the landed batch [' + firstRound + '..' +
                    lastRound + '] to the publisher; its rounds stay buffered:', e && e.message);
            }
        }

        return { accepted: true, stored, duplicates, rejected: 0 };
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
    async _resolveOracleAdmitBlock(sourceChain) {
        let readSet;
        try {
            // The seam's own rule for this table (publishingChain), including its refusal of a
            // row carrying no source_chain: a height with no chain to verify it against is not
            // a weaker stamp, it is an unverifiable one.
            readSet = ah.admissionReadSet('oracle_prices', { source_chain: sourceChain });
        } catch (e) {
            console.warn('PriceAggregator: no admission read set for this PRICE v1 row (' +
                (e && e.message) + '); storing it as a legacy row.');
            return null;
        }
        let chain = readSet[0];

        if (!this.hub || typeof this.hub._resolveAdmissionTip !== 'function') return null;
        let tip;
        try {
            tip = await this.hub._resolveAdmissionTip(chain);
        } catch (e) {
            console.warn('PriceAggregator: the ' + chain + ' admission tip threw (' + (e && e.message) +
                '); storing this PRICE v1 row as a legacy row.');
            return null;
        }
        // typeof, not a coercing check: Number(null) and Number('') are both 0, so a coerced
        // guard would read an ABSENT tip as height 0 and stamp 0 + margin. _resolveAdmissionTip
        // answers null for every failure it handles, and null is not tip zero.
        if (typeof tip !== 'number' || !Number.isSafeInteger(tip) || tip < 0) return null;

        if (!isMirrorAdmissionProducerActive(chain, this.hub && this.hub.network, tip)) return null;

        try {
            // tip + admitMarginBlocks('oracle_prices'), through the one stamp definition, so
            // this rail cannot drift from the margin the barrier certifies it against.
            return ah.admitBlocks(readSet, { [chain]: tip }, 'oracle_prices')[chain];
        } catch (e) {
            console.warn('PriceAggregator: could not stamp an admission height for a ' + chain +
                ' PRICE v1 row (' + (e && e.message) + '); storing it as a legacy row.');
            return null;
        }
    }

    async receiveOraclePrice(sourceChain, priceData) {
        if (!priceData || !priceData.source_address || !priceData.coin || !priceData.tick || !priceData.fiat || !priceData.value) {
            return { accepted: false, reason: 'invalid priceData' };
        }

        // PRICE v1 carries no PBFT signatures on the wire. It is a single
        // user's oracle price whose authenticity is the on-chain transaction
        // itself, which only the indexer that observed the chain can validate.
        // Unlike PRICE v0 rounds (re-verified in receiveValidatedRound), the
        // hub cannot re-check that cryptographically; the gates here are the
        // authenticated push channel, strict field validation (mirroring the
        // indexer's wire-format rules), and the uniform 24h effective_at delay.
        // Bound coin/tick/fiat/memo to the indexer's PRICE v1 wire-format
        // rules (actions/price.js parse_v1). The indexer already rejects these
        // on-chain, so anything outside them here is a malformed or Byzantine
        // push; without the bounds an attacker on the push channel could write
        // arbitrary-size or bogus-key rows into oracle_prices.
        // source_address is the row-identity/dedupe key; bound its type and
        // length like the sibling wire fields (the bare truthiness check above
        // lets a non-string coerce to a bogus identity, and an over-long value
        // errors or truncate-collides the INSERT into oracle_prices).
        if (typeof priceData.source_address !== 'string' || priceData.source_address.length === 0 ||
            priceData.source_address.length > MAX_SOURCE_ADDRESS_LENGTH) {
            return { accepted: false, reason: 'invalid source_address' };
        }
        if (typeof priceData.coin !== 'string' || !PRICE_V1_COINS.includes(priceData.coin)) {
            return { accepted: false, reason: 'invalid coin' };
        }
        if (typeof priceData.tick !== 'string' || priceData.tick.length === 0 || priceData.tick.length > MAX_TICK_LENGTH) {
            return { accepted: false, reason: 'invalid tick' };
        }
        if (typeof priceData.fiat !== 'string' || !PRICE_V1_FIATS.includes(priceData.fiat)) {
            return { accepted: false, reason: 'invalid fiat' };
        }
        if (priceData.memo !== undefined && priceData.memo !== null &&
            (typeof priceData.memo !== 'string' || priceData.memo.length > MAX_MEMO_LENGTH)) {
            return { accepted: false, reason: 'invalid memo' };
        }

        if (!/^[0-9]+(\.[0-9]{1,8})?$/.test(String(priceData.value)) || parseFloat(priceData.value) <= 0 ||
            !(parseFloat(priceData.value) < PRICE_MAX)) {   // PRICE_MAX ceiling at ingest (item 9e6c0acd)
            return { accepted: false, reason: 'invalid value' };
        }
        // FEE upper bound uses exact bcmath, not parseFloat: an unbounded-precision
        // value like '1.0000000000000000001' rounds to exactly 1.0 under IEEE-754 and
        // would slip past a parseFloat `> 1` gate while exact math treats it as > 1.
        // Mirrors the indexer's price-action FEE validation (wire-format parity).
        if (priceData.fee !== undefined && priceData.fee !== null && priceData.fee !== '' &&
            (!/^[0-9]+(\.[0-9]{1,18})?$/.test(String(priceData.fee)) || bcgt(String(priceData.fee), '1'))) {
            return { accepted: false, reason: 'invalid fee' };
        }

        // Source-chain reorg fence (item 5308): the generation the source indexer carried on
        // this push (0 when absent/malformed). See receiveValidatedRound.
        let pushGeneration = parseInt(priceData.push_generation);
        if (!Number.isFinite(pushGeneration) || pushGeneration < 0) pushGeneration = 0;

        // Gate the two remaining required wire fields instead of coercing them. Unlike
        // push_generation, whose absence has a meaningful default (0 = pre-fence sender),
        // action_index and block_time are load-bearing identity/time values with no sane
        // default, and the old `parseInt(x) || 0` silently minted one for malformed input.
        // Digits only and inside the safe-integer range: both columns are BIGINT UNSIGNED
        // and parseInt rounds silently past 2^53, so an over-large value would mis-key the row.
        //
        // action_index keys the (source_chain, action_index) unique index, the dedupe SELECT
        // and the retraction fence below; collapsing it to 0 collided malformed pushes from
        // DIFFERENT operators on one chain onto a single index-0 row (the unique key carries no
        // source_address) and left the fence reading an index the action never had. A genuine
        // index of 0 is still accepted; only unparseable input is rejected.
        if (!/^[0-9]+$/.test(String(priceData.action_index)) ||
            !Number.isSafeInteger(Number(priceData.action_index))) {
            return { accepted: false, reason: 'invalid action_index' };
        }
        // block_time is the base of the uniform 24h effective_at delay documented below;
        // coercing it to 0 produced effective_at 86400 (1970-01-02), which the
        // `effective_at <= now` read path serves immediately, i.e. the delay silently off.
        // Deliberately NOT bounded to a recency window against the hub clock: a rebuilt indexer
        // replays history and pushes genuine old block_times (see the fence warning above), so a
        // freshness bound would reject exactly the backfill the durable outbox exists to deliver.
        if (!/^[0-9]+$/.test(String(priceData.block_time)) ||
            !Number.isSafeInteger(Number(priceData.block_time)) ||
            Number(priceData.block_time) <= 0) {
            return { accepted: false, reason: 'invalid block_time' };
        }
        let actionIndex = parseInt(priceData.action_index, 10);

        // HUB-RETRACT-4: reject a stale replay of a rolled-back PRICE action. A fire-and-forget v1
        // push that failed and was re-enqueued, or an in-flight HTTP push, can land AFTER the reorg
        // retraction that deleted its row, still carrying the pre-reorg generation. The ingest fence
        // rejects any push whose generation <= the chain's processed retraction generation AND whose
        // action_index sits in that retraction's orphaned range; the re-published canonical row
        // carries a higher generation (or a below-orphan action_index) and passes. No watermark row
        // exists until the first retraction, so genuine pre-reorg generation-0 pushes are never hit.
        let wm = await this.db.getPriceIngestWatermark(sourceChain || '', this._fenceNetwork());
        if (wm && pushGeneration <= wm.retraction_generation && actionIndex >= wm.from_action_index) {
            // Never silent: a rebuilt indexer trips this fence on every push.
            this._warnIngestFenceRejection(sourceChain, 'PRICE v1 oracle', pushGeneration, actionIndex, wm);
            return { accepted: false, reason: 'stale (retracted generation)' };
        }

        // Dedupe by (source_address, source_chain, action_index). A strictly NEWER-generation push
        // at a recycled action_index is NOT a duplicate: it is the canonical re-publication and must
        // supersede a stale row that escaped retraction (the monotonic upsert below overwrites only
        // when strictly newer). An equal-or-older generation is a true idempotent duplicate.
        let existing = await this.db.doQuery(
            'SELECT id, push_generation FROM oracle_prices WHERE source_address = ? AND source_chain = ? AND action_index = ? LIMIT 1',
            [priceData.source_address, sourceChain || '', actionIndex]
        );
        if (existing && existing.length > 0) {
            let existingGen = parseInt(existing[0].push_generation) || 0;
            if (pushGeneration <= existingGen) {
                return { accepted: false, reason: 'duplicate' };
            }
            // else fall through: a newer generation supersedes the stale row via the upsert.
        }

        // Determine effective_at: every publish (first or update) is delayed by 24h
        // from its action's block_time. The delay on updates prevents front-running
        // attacks on dispensers. The delay on first publishes exists for consensus:
        // an immediate first publish was retroactively effective (effective_at =
        // block_time, which precedes the row's arrival in any hub/mirror by the
        // source chain's indexing lag), so a FIAT dispense settled live could replay
        // differently once the row existed (a ledger fork). A uniform +24h makes
        // every row land in every mirror long before any block can read it, which
        // is also what makes the hub-db sync stream watermark a sound barrier.
        let blockTime = parseInt(priceData.block_time, 10);   // gated above; never coerced to 0
        let effectiveAt = blockTime + 86400;

        // THE ADMISSION HEIGHT for this row (R5 (a)), resolved from THIS hub's own ingest
        // because nothing else can: a PRICE v1 action is user-submitted, carries no
        // signatures and no canonical, and its wire payload carries no block HEIGHT at all.
        // NULL on every failure, never 0: a legacy row binds by effective_time at every
        // height, which is the fail-closed direction, while a zero would admit the row at a
        // block every live chain passed years ago.
        let admitBlock = await this._resolveOracleAdmitBlock(sourceChain);

        // Generation-monotonic upsert (HUB-RETRACT-4): on the (source_chain, action_index) unique
        // key, a lower-or-equal generation never overwrites a newer row, so a late stale push can
        // neither insert an orphan (fenced above) nor clobber the canonical re-publication here.
        // push_generation is assigned LAST so every column IF reads the pre-update generation.
        //
        // admit_block rides the same generation guard as every other column: a re-published
        // row at a recycled action_index carries the NEW ingest's height, and a stale replay
        // can never move the height a live reader has already bound against. It is APPENDED
        // after push_generation rather than slotted beside the other row columns, so every
        // existing positional read of this args array keeps its index; the UPDATE clause
        // still assigns it BEFORE push_generation, which is what the IF guards depend on.
        let query = `INSERT INTO oracle_prices
            (source_address, source_chain, coin, tick, fiat, value, fee, memo, block_time, effective_at, action_index, push_generation, admit_block)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                source_address = IF(VALUES(push_generation) > push_generation, VALUES(source_address), source_address),
                coin           = IF(VALUES(push_generation) > push_generation, VALUES(coin), coin),
                tick           = IF(VALUES(push_generation) > push_generation, VALUES(tick), tick),
                fiat           = IF(VALUES(push_generation) > push_generation, VALUES(fiat), fiat),
                value          = IF(VALUES(push_generation) > push_generation, VALUES(value), value),
                fee            = IF(VALUES(push_generation) > push_generation, VALUES(fee), fee),
                memo           = IF(VALUES(push_generation) > push_generation, VALUES(memo), memo),
                block_time     = IF(VALUES(push_generation) > push_generation, VALUES(block_time), block_time),
                effective_at   = IF(VALUES(push_generation) > push_generation, VALUES(effective_at), effective_at),
                admit_block    = IF(VALUES(push_generation) > push_generation, VALUES(admit_block), admit_block),
                push_generation = GREATEST(push_generation, VALUES(push_generation))`;
        let args = [
            priceData.source_address, sourceChain || '',
            priceData.coin, priceData.tick, priceData.fiat,
            priceData.value, priceData.fee || null, priceData.memo || null,
            blockTime, effectiveAt, actionIndex, pushGeneration, admitBlock
        ];
        try {
            await this.db.doQuery(query, args);
        } catch (err) {
            console.error('PriceAggregator: error inserting oracle price:', err);
            return { accepted: false, reason: 'db error' };
        }

        // Emit row event so the hub DB sync channel can broadcast to subscribers
        this.emit('row:inserted', {
            table: 'oracle_prices',
            row: {
                source_address: priceData.source_address,
                source_chain:   sourceChain || '',
                coin:           priceData.coin,
                tick:           priceData.tick,
                fiat:           priceData.fiat,
                value:          priceData.value,
                fee:            priceData.fee || null,
                memo:           priceData.memo || null,
                block_time:     blockTime,
                effective_at:   effectiveAt,
                action_index:   actionIndex,   // the validated integer, matching the stored row
                admit_block:    admitBlock,    // null is the legacy row, and it binds by effective_time
                push_generation: pushGeneration
            }
        });

        console.log('PriceAggregator: accepted PRICE v1 from ' + priceData.source_address + ' (' + priceData.coin + '/' + priceData.tick + '/' + priceData.fiat + ' = ' + priceData.value + ', effective_at=' + effectiveAt + ')');
        return { accepted: true };
    }

    // Retract price rows seeded from PRICE actions that an indexer rolled back
    // during a reorg. The indexer pushes the source chain plus the lowest
    // rolled-back action_index; we delete every row tagged with that chain whose
    // source action_index is >= that value, across both price tables.
    //
    // This is the indexer-driven counterpart to ReorgHandler, which only reacts
    // to a separate PBFT reorg attestation. PBFT attestations never arrive for
    // non-PBFT reorgs, so without this path orphaned prices would survive
    // indefinitely and feed getLatestPrice / getOracleDataForVM / fee validation.
    //
    // sourceChain:     BTC | LTC | DOGE
    // fromActionIndex: lowest rolled-back action_index (inclusive)
    // Returns { retracted: { price_snapshots, oracle_prices } } with deleted row counts.
    // toActionIndex (optional) bounds the retraction to a CLOSED range [from, to]. A DEFERRED
    // (queued) retraction passes it so a price row re-published inside the original open-ended
    // range is not deleted (item 5296). Absent => open-ended `>= from`, the live-retraction
    // behavior. The bound is mirrored onto the row:deleted event so replicas apply the same delete.
    // retractionGeneration (optional, item 5308) is the source chain's push generation captured at
    // rollback start. When present, only rows stamped with push_generation <= it are deleted, so a
    // row re-published at a recycled action_index (higher generation) survives even though it falls
    // inside [from, to]. Omitted (older indexer) => no fence == today's behavior; the bound is
    // mirrored onto row:deleted so replicas fence identically.
    async retractFromActionIndex(sourceChain, fromActionIndex, toActionIndex, retractionGeneration) {
        // Fail-closed on a SUPPLIED-but-invalid bound: a malformed to/generation used to
        // collapse into the absent branch and widen this into the open-ended DELETE below.
        let bounds = normalizeRetractionBounds(fromActionIndex, toActionIndex, retractionGeneration);
        if (bounds.error) return { error: bounds.error };
        let { from, to, gen, bounded, fenced } = bounds;

        // Build the shared WHERE tail once; the only per-table difference is the action-index column.
        let buildArgs = (col) => {
            let where = 'source_chain = ? AND ' + col + (bounded ? ' >= ? AND ' + col + ' <= ?' : ' >= ?') + (fenced ? ' AND push_generation <= ?' : '');
            let args = [sourceChain, from];
            if (bounded) args.push(to);
            if (fenced) args.push(gen);
            return { where, args };
        };

        // price_snapshots tracks the PRICE v0 round action via source_action_index
        let snapQ = buildArgs('source_action_index');

        // D28: the rounds a retracted BATCH carried, read BEFORE the DELETE because
        // afterwards there is nothing left to read them off. Batch-sourced rows are the
        // ones whose consensus_proof is the {"batch":...} object of D23; a v0-sourced
        // row's proof is a bare signature ARRAY, so the prefix is an exact discriminator
        // and v0 retraction behaviour is untouched. Only worth a query when a publisher
        // exposing the clear seam is actually wired: on a mirror hub the answer has no
        // consumer, so the retraction path stays a two-statement path there.
        let publisher = this.hub && this.hub.oraclePublisher;
        let canClearMarkers = !!(publisher && typeof publisher.clearPublishedMarkers === 'function');
        if (publisher && !canClearMarkers) {
            console.warn('PriceAggregator: OraclePublisher is wired but exposes no clearPublishedMarkers(rounds);'
                + ' a retracted PRICE batch will stay marked as published and the at-most-once guard will'
                + ' suppress the recovery re-publish, costing an hour of price history rather than a round.');
        }
        let batchRounds = [];
        if (canClearMarkers) {
            try {
                let rows = await this.db.doQuery(
                    'SELECT DISTINCT round_number FROM price_snapshots WHERE ' + snapQ.where
                        + " AND consensus_proof LIKE '{\"batch\":%'",
                    snapQ.args);
                for (let row of (rows || [])) {
                    let n = parseInt(row.round_number);
                    if (Number.isFinite(n)) batchRounds.push(n);
                }
            } catch (e) {
                console.error('PriceAggregator: could not read the retracted batch rounds for ' + sourceChain + ':', e && e.message);
            }
        }

        // HUB-RETRACT-4: durably record this retraction's generation + orphaned-range lower bound
        // so a stale price push (a fire-and-forget or in-flight PRICE arriving AFTER the delete, or
        // a retried push carrying the pre-reorg generation) is rejected at ingest instead of
        // re-inserting the orphan. Only when the source carried a generation to fence on; without
        // it we cannot tell stale from fresh, so we leave the fence untouched (pre-fix behaviour).
        // Runs even on a 0-row delete: the stale push may not have arrived yet.
        //
        // Written BEFORE the deletes, and a failed write aborts the retraction rather than being
        // logged and forgotten. The caller drops its durable outbox row on a success return
        // (xchain-indexer hub_push_queue.js markHubPushDelivered), so a swallowed failure left the
        // rows deleted, the fence unpersisted and no retry anywhere in the fleet. Early is safe
        // because the fence is monotonic (GREATEST generation, LEAST from in db.js
        // bumpPriceIngestWatermark), so it can only reject pushes this retraction is about to
        // delete; there is no hub-side transaction spanning both, so this is fail-closed, not
        // atomic. Keep the error wording clear of the indexer's TERMINAL_HUB_REJECTIONS patterns
        // (xchain-indexer/src/hub_client.js) or the retained retry becomes a silent drop.
        if (fenced) {
            try {
                await this.db.bumpPriceIngestWatermark(sourceChain, gen, from, this._fenceNetwork());
            } catch (e) {
                console.error('PriceAggregator: ingest-watermark bump failed for ' + sourceChain + ':', e && e.message);
                return { error: 'ingest fence not persisted for ' + sourceChain
                    + ' (' + ((e && e.message) || 'unknown error') + ')' };
            }
        }

        let snapResult = await this.db.doQuery('DELETE FROM price_snapshots WHERE ' + snapQ.where, snapQ.args);
        // oracle_prices tracks the PRICE v1 oracle action via action_index
        let oracleQ = buildArgs('action_index');
        let oracleResult = await this.db.doQuery('DELETE FROM oracle_prices WHERE ' + oracleQ.where, oracleQ.args);

        let snapDeleted   = (snapResult   && snapResult.affectedRows   !== undefined) ? Number(snapResult.affectedRows)   : 0;
        let oracleDeleted = (oracleResult && oracleResult.affectedRows !== undefined) ? Number(oracleResult.affectedRows) : 0;

        // Tell the hub DB sync channel to mirror these deletes so distributed
        // indexers prune their local price-table copies too. Carry to_action_index and
        // retraction_generation so the replica's _applyRetraction bounds and fences its
        // delete identically (hub<->replica parity).
        if (snapDeleted > 0) {
            let evt = { table: 'price_snapshots', source_chain: sourceChain, from_action_index: from };
            if (bounded) evt.to_action_index = to;
            if (fenced) evt.retraction_generation = gen;
            this.emit('row:deleted', evt);
        }
        if (oracleDeleted > 0) {
            let evt = { table: 'oracle_prices', source_chain: sourceChain, from_action_index: from };
            if (bounded) evt.to_action_index = to;
            if (fenced) evt.retraction_generation = gen;
            this.emit('row:deleted', evt);
        }

        // D28: clear the publisher's durable at-most-once marker for every round the
        // retracted batch carried. Without this the marker outlives the rows it stands
        // for, the at-most-once guard suppresses the re-publish that recovery needs, and
        // the reorg costs an HOUR of price history instead of a round. Guarded because a
        // publisher failure must never turn a completed retraction into an error return:
        // the rows are already gone.
        if (canClearMarkers && snapDeleted > 0 && batchRounds.length > 0) {
            try {
                await publisher.clearPublishedMarkers(batchRounds);
            } catch (e) {
                console.error('PriceAggregator: clearing published markers for retracted batch rounds '
                    + batchRounds.join(',') + ' failed:', e && e.message);
            }
        }

        console.log('PriceAggregator: retracted ' + snapDeleted + ' price_snapshots + ' + oracleDeleted + ' oracle_prices rows from ' + sourceChain + ' (action_index >= ' + from + (bounded ? ' AND <= ' + to : '') + (fenced ? ' AND push_generation <= ' + gen : '') + ')');
        return { retracted: { price_snapshots: snapDeleted, oracle_prices: oracleDeleted } };
    }

    /* ── Derived capability snapshots ─────────────────────────────────────────
     *
     * NOTHING wrote a capability snapshot of ANY kind on a hub that does not run oracle
     * consensus. For `price` the sole writer was OracleConsensus._persistCapabilitySnapshot on the
     * round-FINALIZATION path, which only a validator hub reaches, so a chain-only node
     * (an indexer whose only price source is the on-chain batch, pointed at its own
     * standalone hub) mirrored an empty capability_snapshots and recorded EVERY landed
     * batch `invalid: insufficient signer stake`: off BTC the indexer resolves the price
     * set from the hub-mirrored table alone (xchain-indexer db.js usesCapabilitySnapshot),
     * so the qualified set was empty, S summed to zero and the strict bar could not be
     * met by signatures that all verify. Measured on the real testnet chain-only node
     * 2026-09-09: 60 batches parsed, 60 refusals, capability_snapshots empty in all three
     * of its databases while its Bitcoin view answered HTTP 200.
     *
     * THE ORDERING IS WHY THIS IS A TIMER AND NOT AN INGEST HOOK. The indexer validates a
     * parsed batch BEFORE it pushes it to the hub, so a fix that filled the snapshot when
     * a VALID batch arrived could never fire: no snapshot means invalid, invalid means no
     * push, no push means no snapshot. Nothing on the receive path may be the trigger.
     * The hub therefore DERIVES the set for a WINDOW of BTC heights straight from the
     * configured Bitcoin indexer (operator ruling 2026-09-09), on its own clock, before
     * and independently of any batch, and persists it through the same shared writer the
     * consensus path uses so both paths produce byte-identical rows.
     *
     * Validator identity still goes through Bitcoin: every row here comes from
     * CapabilitySnapshot's `getcapabilityvalidators` / `getstakeweightsbycapability` read
     * against the BTC indexer at a BTC height, exactly as the consensus path resolves it.
     * Nothing is invented locally, and an unreachable or truncated read writes NOTHING.
     *
     * THE SAME HOLE EXISTS FOR EVERY OTHER CAPABILITY, and each has its own refusal.
     * `price` was simply the one the batch rail surfaced first. On the same measured
     * chain-only node, of 13 verdict divergences against origin, five were ATTEST actions
     * refused `invalid: insufficient signer stake` for a missing `attestation` snapshot
     * and one was an ANCHOR archive head stored `unverified` for a missing
     * `oracle_publish` snapshot (xchain-indexer actions/anchor.js:519 documents that
     * exact behaviour). So the pass derives every name in DERIVED_CAPABILITIES, on the
     * same window, the same clock and the same shared writer.
     */

    // The kill switch. Any value but 'off' (case-insensitive) leaves derivation on,
    // because a hub that silently stops writing these rows is the failure this whole
    // path exists to close: an operator must have to spell the word to lose it.
    _priceCapabilityDerivationEnabled() {
        return String(process.env.HUB_PRICE_CAPABILITY_DERIVE || '').trim().toLowerCase() !== 'off';
    }

    // True when THIS hub holds a signing identity, the precondition every consensus
    // writer of a capability snapshot has: each of them persists on a path that
    // finalizes, co-signs or publishes under this hub's own key, so a hub that signs
    // nothing can never reach one however many engines its boot built. startP2P sets
    // `identity` from SIGNING_PRIVKEY_HEX BEFORE it constructs the peer manager, and
    // every start*() that builds an engine is awaited after that, so this signal is
    // settled earlier in boot than any engine and closes the boot race on its own.
    _hasSigningIdentity() {
        if (!this.hub) return false;
        if (this.hub.identity) return true;
        try {
            if (typeof this.hub.getIdentity === 'function' && this.hub.getIdentity()) return true;
        } catch (e) { /* a hub double without an identity accessor signs nothing */ }
        return false;
    }

    // True when the consensus path ON THIS HUB already writes `capability`'s snapshot,
    // in which case the derivation pass leaves that capability alone.
    //
    // PER CAPABILITY, never one answer for all four. The previous gate asked a single
    // question ("does this hub run oracle consensus?") and answered it from the PEER
    // MANAGER, which made the whole pass disarm on any hub in the mesh. That is exactly
    // the shape the public tier runs: a peer manager so it receives federation frames,
    // no signing key, so no round it sees is ever finalized under its key and NOTHING
    // writes oracle_publish, cross_chain or attestation on it. Those three stayed
    // uncovered on every such hub, which is the ATTEST refusal and the `unverified`
    // ANCHOR archive head the chain-only node measured.
    //
    // Engine presence refines the identity signal rather than replacing it: a validator
    // that holds one capability's writer and not another's derives only the missing one.
    // A spurious derive costs nothing if a slow boot has not yet built an engine: the
    // rows are byte-identical to the consensus writer's and INSERT IGNORE makes either
    // order a no-op for the other (see _persistDerivedCapabilitySnapshot).
    _runsConsensusFor(capability) {
        if (!this.hub) return false;
        if (!this._hasSigningIdentity()) return false;
        let engines = CAPABILITY_CONSENSUS_ENGINES[capability] || [];
        return engines.some(name => Boolean(this.hub[name]));
    }

    // The `price` question under its original name; XChainHub's arming comment points
    // here for why a validator hub needs no derivation pass.
    _runsOracleConsensus() {
        return this._runsConsensusFor('price');
    }

    // The capabilities this hub must derive for itself: every name whose consensus
    // writer does not run here. Empty means the consensus path covers all four and the
    // pass has nothing left to do.
    _capabilitiesToDerive() {
        return DERIVED_CAPABILITIES.filter(c => !this._runsConsensusFor(c));
    }

    // Arm the derivation pass. Called from XChainHub.start() unconditionally: the
    // pass itself decides whether this hub needs it, because start() runs BEFORE
    // startP2P/startOracle and cannot yet tell a validator from a standalone hub.
    startPriceCapabilityDerivation() {
        if (this._priceCapDeriveTimer) return false;
        if (!this._priceCapabilityDerivationEnabled()) {
            console.warn('PriceAggregator: HUB_PRICE_CAPABILITY_DERIVE=off, so this hub will not derive '
                + 'capability snapshots (' + DERIVED_CAPABILITIES.join(', ') + '). For every one of them '
                + 'whose consensus writer does not run here, nothing else writes them: every on-chain '
                + 'PRICE batch and every ATTEST its '
                + 'indexer parses will read `invalid: insufficient signer stake`, and every ANCHOR archive '
                + 'head will be stored `unverified`.');
            return false;
        }
        let intervalS = positiveIntConfig(process.env.HUB_PRICE_CAPABILITY_DERIVE_INTERVAL_S,
            PRICE_CAP_DERIVE_INTERVAL_S, 'HUB_PRICE_CAPABILITY_DERIVE_INTERVAL_S');
        // The FIRST pass waits a full interval rather than firing now: start() has not yet
        // been followed by startP2P/startOracle, so a pass at t=0 would run on a validator
        // hub before the signals that identify it exist. See _runsOracleConsensus.
        this._priceCapDeriveTimer = setInterval(() => {
            this.runPriceCapabilityDerivation().catch(e => {
                console.error('PriceAggregator: `price` capability derivation pass failed:',
                    e && e.message ? e.message : e);
            });
        }, intervalS * 1000);
        // Never hold the process open: this is a background repair, not work anyone waits on.
        if (typeof this._priceCapDeriveTimer.unref === 'function') this._priceCapDeriveTimer.unref();
        return true;
    }

    stopPriceCapabilityDerivation() {
        if (this._priceCapDeriveTimer) {
            clearInterval(this._priceCapDeriveTimer);
            this._priceCapDeriveTimer = null;
        }
    }

    // One derivation pass. Resolves the BTC tip, covers the newest uncovered heights in
    // the lookback window, and returns what it did so a test or an operator RPC can read
    // the pass rather than infer it from logs.
    async runPriceCapabilityDerivation() {
        if (this._priceCapDeriveRunning) return { ran: false, reason: 'pass already running' };
        if (!this._priceCapabilityDerivationEnabled()) return { ran: false, reason: 'disabled' };
        // A hub whose consensus path writes EVERY derived capability keeps its existing
        // behaviour exactly: those writers own these rows there, and this pass disarms
        // itself for the process. One covered capability disarms nothing: the pass runs
        // for the rest, which is the whole of
        let capabilities = this._capabilitiesToDerive();
        if (capabilities.length === 0) {
            this.stopPriceCapabilityDerivation();
            return { ran: false, reason: 'hub runs consensus for every derived capability' };
        }

        this._priceCapDeriveRunning = true;
        try {
            let tip = await this.hub._resolveBtcLatestBlock();
            let t   = Number(tip);
            // FAIL CLOSED, LOUDLY. _resolveBtcLatestBlock returns null for an unreachable
            // indexer, a stale pushed tip and an over-lagged direct tip alike, and every
            // one of those means this hub cannot know the qualifying set at any height.
            // Deriving from a guessed height would mirror a set nobody can verify.
            if (!Number.isFinite(t) || t <= 0) {
                console.error('PriceAggregator: cannot derive capability snapshots: the '
                    + 'configured Bitcoin view returned no usable tip. Nothing written. Until it '
                    + 'answers, every on-chain PRICE batch and every ATTEST this node parses reads '
                    + '`invalid: insufficient signer stake` and every ANCHOR archive head is stored '
                    + '`unverified`.');
                return { ran: false, reason: 'no btc tip' };
            }
            t = Math.floor(t);

            let lookback = positiveIntConfig(process.env.HUB_PRICE_CAPABILITY_DERIVE_LOOKBACK_BLOCKS,
                PRICE_CAP_DERIVE_LOOKBACK_BLOCKS, 'HUB_PRICE_CAPABILITY_DERIVE_LOOKBACK_BLOCKS');
            let from = Math.max(0, t - lookback + 1);

            // Bound every memory set to the window. Pruning by HEIGHT rather than by
            // insertion order is what makes them bounded and exact at once: a height that
            // has fallen out of the window is never revisited, so forgetting it costs
            // nothing, and nothing inside the window is ever forgotten and re-derived.
            for (let capability of capabilities) {
                let done = this._coveredBlocks(this._capDerivedBlocks, capability);
                let warned = this._coveredBlocks(this._capWarnedBlocks, capability);
                for (let b of [...done])   if (b < from) done.delete(b);
                for (let b of [...warned]) if (b < from) warned.delete(b);
            }

            // Newest first, and ALL capabilities at a height before stepping back one: the
            // tip is the height the next landed batch, ATTEST or archive head anchors
            // nearest, so a cold hub covers everything it needs now before it walks the
            // backfill. The cap counts RPC units, so widening the capability list spends no
            // more indexer budget per tick than the price-only pass did.
            let todo = [];
            for (let b = t; b >= from && todo.length < PRICE_CAP_DERIVE_MAX_PER_TICK; b--) {
                for (let capability of capabilities) {
                    if (todo.length >= PRICE_CAP_DERIVE_MAX_PER_TICK) break;
                    if (!this._coveredBlocks(this._capDerivedBlocks, capability).has(b))
                        todo.push({ capability: capability, block: b });
                }
            }

            let written = 0, rows = 0, empty = 0, failed = 0;
            // Per-capability tallies, so an operator reading one pass can see WHICH
            // capability is stuck rather than a single number that hides three healthy
            // ones behind a fourth.
            let byCapability = {};
            for (let capability of capabilities)
                byCapability[capability] = { written: 0, rows: 0, empty: 0, failed: 0 };

            for (let item of todo) {
                let capability = item.capability, block = item.block;
                let tally = byCapability[capability];
                let res = await this._persistDerivedCapabilitySnapshot(capability, block);
                if (res.status === 'written') {
                    // Covered: remember it so the next pass spends no RPC on it.
                    this._coveredBlocks(this._capDerivedBlocks, capability).add(block);
                    this._coveredBlocks(this._capWarnedBlocks, capability).delete(block);
                    written += 1;  tally.written += 1;
                    rows    += res.rows;  tally.rows += res.rows;
                } else if (res.status === 'empty') {
                    // A genuinely empty qualifying set at this height. Nothing to mirror
                    // and nothing wrong: the read succeeded, so the height is covered and
                    // an off-BTC verifier reading zero rows fails closed, which is the
                    // same verdict this hub would reach.
                    this._coveredBlocks(this._capDerivedBlocks, capability).add(block);
                    empty += 1;  tally.empty += 1;
                } else {
                    // 'unresolved', 'truncated' or 'error': NOT covered, so the next pass
                    // retries it. The warning fires once per capability per height per
                    // process so a stuck indexer names itself without drowning the log
                    // every minute.
                    failed += 1;  tally.failed += 1;
                    let warned = this._coveredBlocks(this._capWarnedBlocks, capability);
                    if (!warned.has(block)) {
                        warned.add(block);
                        console.warn('PriceAggregator: no `' + capability + '` capability snapshot written at '
                            + 'BTC block ' + block + ' (' + res.status + (res.detail ? ': ' + res.detail : '') + '). '
                            + 'An action anchored there that needs the `' + capability + '` set will read '
                            + '`invalid: insufficient signer stake` (or be stored `unverified`) until this '
                            + 'resolves; retrying each pass.');
                    }
                }
            }

            this.priceCapabilityBlocksDerived += written;
            this.priceCapabilityRowsDerived   += rows;
            if (written > 0) {
                let per = capabilities
                    .filter(c => byCapability[c].written > 0)
                    .map(c => c + ' ' + byCapability[c].written)
                    .join(', ');
                console.log('PriceAggregator: derived capability snapshots for ' + written
                    + ' (capability, BTC block) pair(s) (' + rows + ' rows) in [' + from + ', ' + t + ']'
                    + (per ? ' [' + per + ']' : '')
                    + (empty ? ', ' + empty + ' pair(s) resolved empty' : '')
                    + (failed ? ', ' + failed + ' pair(s) unresolved' : ''));
            }
            return { ran: true, tip: t, from: from, considered: todo.length,
                     written: written, rows: rows, empty: empty, failed: failed,
                     capabilities: capabilities.slice(), byCapability: byCapability };
        } finally {
            this._priceCapDeriveRunning = false;
        }
    }

    // The per-capability height set inside one of the two Maps, created on first use.
    // Split out so the pass, the prune and the tests all reach the same object rather
    // than each re-deriving "does this Map already have a Set for this capability".
    _coveredBlocks(map, capability) {
        let set = map.get(capability);
        if (!set) { set = new Set(); map.set(capability, set); }
        return set;
    }

    // Resolve the qualifying validator set for `capability` at a BTC block, normalized to
    // { pubkey, source, weight, amount }.
    //
    // The resolution is OracleConsensus._resolveCapabilityValidators verbatim (same
    // activation key, same two RPCs, same normalization, same truncation marker), with
    // ONE deliberate difference: a degraded read returns null here instead of collapsing
    // to []. Both refuse to write, but only the null tells the caller the Bitcoin view
    // failed, which is the difference between "retry and say so" and "this height really
    // has no qualified validators".
    //
    // The capability is a pass-through to the BTC indexer RPC, exactly as it is in the
    // six consensus writers: `getcapabilityvalidators` / `getstakeweightsbycapability`
    // take it as a parameter, and CapabilitySnapshot keys its cache and its min_stake
    // lookup on it. Nothing else about the resolution differs per capability, which is
    // why one resolver serves all four.
    async _resolveDerivedCapabilityValidators(capability, block) {
        let capSnapshot = this.hub ? this.hub.capabilitySnapshot : null;
        if (!capSnapshot) return null;
        // The hub's OWN deployment network is the activation key for every capability,
        // `cross_chain` included: STAKE_WEIGHTED_QUORUM_ACTIVATION is keyed
        // mainnet/testnet/regtest, and the engines' third `network` argument carries the
        // same value read off the match row. See DERIVED_CAPABILITIES.
        let weighted = swq.isStakeWeightedQuorumActive(block, this.hub.network);
        if (weighted) {
            if (typeof capSnapshot.getWeightSnapshot !== 'function') return null;
            let snap = await capSnapshot.getWeightSnapshot(capability, block);
            if (!snap || !Array.isArray(snap.validators)) return null;
            let validators = snap.validators.map(v => ({
                pubkey: v.pubkey,
                source: String(v.source != null ? v.source : ''),
                weight: String(v.weight != null ? v.weight : '0'),
                amount: String(v.weight != null ? v.weight : '0')
            }));
            // Carry the truncation marker through the .map so the persist can refuse an
            // over-cap set (SWQ-TRUNC parity with the other writers).
            if (snap.truncated === true) validators.truncated = true;
            return validators;
        }
        let snap = await capSnapshot.getSnapshot(capability, block);
        if (!snap || !Array.isArray(snap.validators)) return null;
        let counted = snap.validators.map(v => ({
            pubkey: v.pubkey,
            source: '',
            weight: String(v.amount != null ? v.amount : '0'),
            amount: String(v.amount != null ? v.amount : '0')
        }));
        // getSnapshot marks an over-cap COUNT set truncated as well, and the persist guard
        // reads the marker off this array, so carry it in both modes.
        if (snap.truncated === true) counted.truncated = true;
        return counted;
    }

    // The `price` resolver under its original name. CapabilitySnapshotTruncationParity
    // drives this exact signature to prove the COUNT-mode truncation marker survives the
    // .map, and that guard is about the resolver's shape, not about which capability it
    // was asked for, so the name stays and the widened resolver does the work.
    async _resolvePriceCapabilityValidators(block) {
        return this._resolveDerivedCapabilityValidators('price', block);
    }

    // Persist the `capability` set at `block` and mirror it to hub-DB subscribers. The
    // write and the select-back are OracleConsensus._persistCapabilitySnapshot's, through
    // the same shared writer, so the rows a chain-only hub produces are byte-identical to
    // a validator hub's for the same block and INSERT IGNORE makes either order a no-op
    // for the other.
    //
    // Returns { status, rows }: 'written', 'empty' (read fine, nobody qualified),
    // 'unresolved' (the Bitcoin view failed), 'truncated' or 'error'.
    async _persistDerivedCapabilitySnapshot(capability, block) {
        let validators = await this._resolveDerivedCapabilityValidators(capability, block);
        if (validators === null) return { status: 'unresolved', rows: 0, detail: 'Bitcoin view unreachable or degraded' };
        // SWQ-TRUNC-MIRROR, held exactly as OracleConsensus states it: never mirror a
        // TRUNCATED set. The marker is a JS array property with no capability_snapshots
        // column behind it, so persisting the capped rows would hand an off-BTC verifier
        // a partial set it reads back as COMPLETE and let it clear a 2/3 bar over an
        // under-counted stake denominator this hub itself rejects. Writing nothing leaves
        // the mirror empty, so that read yields S=0 and fails closed through the same
        // predicate as everything else.
        if (validators.truncated === true) {
            console.warn('PriceAggregator: refusing to persist a TRUNCATED ' + capability + ' capability '
                + 'snapshot at block ' + block + ' (over the source cap; raise VALIDATOR_QUERY_LIMIT '
                + 'fleet-wide). No rows mirrored.');
            return { status: 'truncated', rows: 0 };
        }
        if (validators.length === 0) return { status: 'empty', rows: 0 };

        let rows;
        try {
            rows = await snapWrite.writeCapabilitySnapshotRows(this.db, capability, block, validators);
        } catch (e) {
            return { status: 'error', rows: 0, detail: e && e.message ? e.message : String(e) };
        }
        // Broadcast the committed rows, keyed on the full widened uq_cap_snap (block,
        // capability, pubkey, SOURCE) exactly as the consensus path re-reads them: a
        // pubkey delegated by two sources has two rows, and a pubkey-only LIMIT 1 re-read
        // would stream only one. Without this the indexer never receives them live.
        // Delivery is not allowed to un-commit the write, so a broadcast failure is
        // reported and the block still counts as covered.
        try {
            if (this.hub && this.hub.hubDbBroadcaster) {
                for (let row of rows) {
                    let r = await this.db.doQuery(
                        'SELECT * FROM capability_snapshots WHERE snapshot_block = ? AND capability = ? AND signing_pubkey = ? AND source = ? LIMIT 1',
                        [block, capability, row.signing_pubkey, row.source]);
                    if (r.length) this.hub.hubDbBroadcaster.broadcastRow({ table: 'capability_snapshots', row: r[0] });
                }
            }
        } catch (e) {
            console.error('PriceAggregator: mirroring the derived ' + capability + ' capability snapshot at '
                + 'block ' + block + ' to subscribers failed: ' + (e && e.message));
        }
        return { status: 'written', rows: rows.length };
    }

    // The `price` persist under its original name, kept for callers and tests that
    // predate the widening (row 45's shape). Same write, same guard, same rows.
    async _persistPriceCapabilitySnapshot(block) {
        return this._persistDerivedCapabilitySnapshot('price', block);
    }
}

module.exports = PriceAggregator;
