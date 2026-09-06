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
const priceSigTally     = require('./price_sig_tally_activation.js');
const swq               = require('./stake_weighted_quorum.js');
const { PRICE_MAX, PRICE_V1_COINS, PRICE_V1_FIATS,
        MAX_TICK_LENGTH, MAX_MEMO_LENGTH, MAX_SOURCE_ADDRESS_LENGTH } = require('./constants.js');
const { PRICE_BATCH_MAX_ROUND_COUNT } = require('./price_batch_compression.js');
const { bcgt }          = require('./bcmath.js');
const { bftQuorumOrSingle } = require('./lib/bft_quorum.js');
const { normalizeRetractionBounds } = require('./lib/retraction_bounds.js');
const roundBandLib      = require('./lib/oracle_round_band.js');

// Minimum gap between ingest-fence rejection warnings for the SAME source
// chain. Sized so a stalled rail keeps re-announcing itself in any log tail while a
// replaying pusher cannot drown the log; the suppressed count rides on the next line.
const FENCE_WARN_INTERVAL_MS = 60_000;

// Minimum gap between missing-pair coverage warnings for the SAME source chain.
// Same sizing rationale as FENCE_WARN_INTERVAL_MS: a pair that stays gone keeps
// re-announcing itself in any log tail, without one stalled feed flooding the log.
const MISSING_PAIR_WARN_INTERVAL_MS = 60_000;

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

    // An ingest-fence rejection USED TO BE silent (a bare
    // { accepted:false } return), and that is how it killed a price rail: reset an
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
            + ' on the hub DB. Otherwise this is a stale replay of a retracted action and the'
            + ' drop is correct.');
    }

    // Build the canonical signable payload for a PRICE v0 round.
    // MUST match xchain-indexer/src/ed25519.js buildPriceV0Payload (and
    // OracleConsensus._buildPriceV0Payload) exactly; validators signed these
    // bytes, so any divergence here rejects every legitimate round.
    _buildPriceV0Payload(round, timestamp, pairs, btcBlockHeight) {
        let sortedPairs = pairs
            .map(p => ({ pair: p.pair, price: String(p.price) }))
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
        for (let p of roundData.pairs) {
            if (!p || typeof p.pair !== 'string' || !pairPattern.test(p.pair) ||
                p.price === undefined || p.price === null || !/^[0-9]+(\.[0-9]+)?$/.test(String(p.price)) ||
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
        let payload    = this._buildPriceV0Payload(round, timestamp, roundData.pairs, btcBlockHeight);
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
            let wm = await this.db.getPriceIngestWatermark(sourceChain || '');
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
                    p.price === undefined || p.price === null || !/^[0-9]+(\.[0-9]+)?$/.test(String(p.price)) ||
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
            let wm = await this.db.getPriceIngestWatermark(sourceChain || '');
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
                continue;
            }

            // Column semantics pinned so a v2-sourced row is indistinguishable from a
            // v0-sourced one (§5.7): block_timestamp is the ROUND's own timestamp (the
            // field the fee path reads), and reference_block is the PUSH's block_index,
            // the landing block on the landing chain (D8), NOT the round's BTC anchor.
            // Two consensus readers read reference_block, so a v2 row that differed here
            // would fork them.
            let insertedRows = [];
            let placeholders = r.pairs.map(() => "(?, ?, ?, ?, ?, ?, ?, 1, ?, 'finalized', ?, ?, ?, ?)").join(', ');
            let params = [];
            for (let p of r.pairs) {
                params.push(r.round, p.pair, p.price, referenceBlock, sourceChain || null, r.timestamp,
                            validatorCount, proofJson, sourceChain || null, sourceActionIndex, pushGeneration, createdAt);
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

        return { accepted: true, stored, duplicates, rejected: 0 };
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
        let wm = await this.db.getPriceIngestWatermark(sourceChain || '');
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

        // Generation-monotonic upsert (HUB-RETRACT-4): on the (source_chain, action_index) unique
        // key, a lower-or-equal generation never overwrites a newer row, so a late stale push can
        // neither insert an orphan (fenced above) nor clobber the canonical re-publication here.
        // push_generation is assigned LAST so every column IF reads the pre-update generation.
        let query = `INSERT INTO oracle_prices
            (source_address, source_chain, coin, tick, fiat, value, fee, memo, block_time, effective_at, action_index, push_generation)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                push_generation = GREATEST(push_generation, VALUES(push_generation))`;
        let args = [
            priceData.source_address, sourceChain || '',
            priceData.coin, priceData.tick, priceData.fiat,
            priceData.value, priceData.fee || null, priceData.memo || null,
            blockTime, effectiveAt, actionIndex, pushGeneration
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
                await this.db.bumpPriceIngestWatermark(sourceChain, gen, from);
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
}

module.exports = PriceAggregator;
