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
const { PRICE_MAX }     = require('./constants.js');

class PriceAggregator extends EventEmitter {

    constructor(hub) {
        super();
        this.hub = hub;
        this.db  = hub.db;
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

    // The pusher's local validation is NOT trusted: before any row is stored
    // as 'finalized', every signature is re-verified here against the
    // canonical payload, signers must be in the price-capability validator
    // snapshot at block_index, and the verified count must meet PBFT quorum.
    // Returns: { accepted, reason } where reason explains the rejection
    async receiveValidatedRound(sourceChain, roundData) {
        if (!roundData || !roundData.round || !Array.isArray(roundData.pairs) || roundData.pairs.length < 1) {
            return { accepted: false, reason: 'invalid roundData' };
        }

        let round = parseInt(roundData.round);
        if (!Number.isFinite(round) || round < 0) {
            return { accepted: false, reason: 'invalid round' };
        }

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
        // below is byte-exact with what the validators signed
        for (let p of roundData.pairs) {
            if (!p || typeof p.pair !== 'string' || !/^[A-Z]{3,5}\/[A-Z]{3,5}$/.test(p.pair) ||
                p.price === undefined || p.price === null || !/^[0-9]+(\.[0-9]+)?$/.test(String(p.price)) ||
                // Enforce the consensus PRICE_MAX ceiling at ingest, as constants.js mandates
                // ("the ingestion layer must reject anything at or above it"); every other
                // price entry point already does, so the ingest/aggregate bounds cannot drift
                // apart and a Byzantine round cannot smuggle an at/above-PRICE_MAX pair past
                // ingest (item 9e6c0acd).
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

        // Resolve the deterministic price-capability validator set at the
        // round's block. Fail closed: without the snapshot the sigs cannot be
        // checked against the qualified set, so the round is rejected rather
        // than stored on trust.
        let snapshot = this.hub.capabilitySnapshot
            ? await this.hub.capabilitySnapshot.getSnapshot('price', referenceBlock)
            : null;
        if (!snapshot || !Array.isArray(snapshot.validators)) {
            return { accepted: false, reason: 'validator snapshot unavailable' };
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
        for (let s of sigs) {
            if (seenPubkey.has(s.pubkey)) continue;        // duplicate pubkey counts once
            seenPubkey.add(s.pubkey);
            if (!qualified.has(s.pubkey)) continue;        // not price-qualified at this block
            if (!ValidatorIdentity.verify(payload, s.sig, s.pubkey)) continue;
            verifiedSigs.push(s);
        }

        // PBFT quorum over the snapshot size, floored at a simple majority:
        // max(2 * floor((N - 1) / 3) + 1, ceil((N + 1) / 2)).
        // This is the same threshold the indexer enforces when validating the action.
        let setSize = Number.isFinite(parseInt(snapshot.count)) ? parseInt(snapshot.count) : snapshot.validators.length;
        let quorum  = (setSize <= 1) ? 1 : Math.max(2 * Math.floor((setSize - 1) / 3) + 1, Math.ceil((setSize + 1) / 2));
        if (verifiedSigs.length < quorum) {
            return { accepted: false, reason: 'insufficient quorum (' + verifiedSigs.length + '/' + quorum + ')' };
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
        return { accepted: true };
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
        if (!/^[0-9]+(\.[0-9]{1,8})?$/.test(String(priceData.value)) || parseFloat(priceData.value) <= 0 ||
            !(parseFloat(priceData.value) < PRICE_MAX)) {   // PRICE_MAX ceiling at ingest (item 9e6c0acd)
            return { accepted: false, reason: 'invalid value' };
        }
        if (priceData.fee !== undefined && priceData.fee !== null && priceData.fee !== '' &&
            (!/^[0-9]+(\.[0-9]+)?$/.test(String(priceData.fee)) || parseFloat(priceData.fee) > 1)) {
            return { accepted: false, reason: 'invalid fee' };
        }

        // Source-chain reorg fence (item 5308): the generation the source indexer carried on
        // this push (0 when absent/malformed). See receiveValidatedRound.
        let pushGeneration = parseInt(priceData.push_generation);
        if (!Number.isFinite(pushGeneration) || pushGeneration < 0) pushGeneration = 0;
        let actionIndex = parseInt(priceData.action_index) || 0;

        // HUB-RETRACT-4: reject a stale replay of a rolled-back PRICE action. A fire-and-forget v1
        // push that failed and was re-enqueued, or an in-flight HTTP push, can land AFTER the reorg
        // retraction that deleted its row, still carrying the pre-reorg generation. The ingest fence
        // rejects any push whose generation <= the chain's processed retraction generation AND whose
        // action_index sits in that retraction's orphaned range; the re-published canonical row
        // carries a higher generation (or a below-orphan action_index) and passes. No watermark row
        // exists until the first retraction, so genuine pre-reorg generation-0 pushes are never hit.
        let wm = await this.db.getPriceIngestWatermark(sourceChain || '');
        if (wm && pushGeneration <= wm.retraction_generation && actionIndex >= wm.from_action_index) {
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
        let blockTime = parseInt(priceData.block_time) || 0;
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
                action_index:   priceData.action_index || 0,
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
        let from = parseInt(fromActionIndex);
        if (!Number.isFinite(from) || from < 0) {
            return { error: 'invalid from_action_index' };
        }
        let to = (toActionIndex !== undefined && toActionIndex !== null) ? parseInt(toActionIndex) : null;
        let bounded = (to !== null && Number.isFinite(to) && to >= 0);
        let gen = (retractionGeneration !== undefined && retractionGeneration !== null) ? parseInt(retractionGeneration) : null;
        let fenced = (gen !== null && Number.isFinite(gen) && gen >= 0);

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

        // HUB-RETRACT-4: durably record this retraction's generation + orphaned-range lower bound
        // so a stale price push (a fire-and-forget or in-flight PRICE arriving AFTER the delete, or
        // a retried push carrying the pre-reorg generation) is rejected at ingest instead of
        // re-inserting the orphan. Only when the source carried a generation to fence on; without
        // it we cannot tell stale from fresh, so we leave the fence untouched (pre-fix behaviour).
        // Runs even on a 0-row delete: the stale push may not have arrived yet.
        if (fenced) {
            try {
                await this.db.bumpPriceIngestWatermark(sourceChain, gen, from);
            } catch (e) {
                console.error('PriceAggregator: ingest-watermark bump failed for ' + sourceChain + ':', e && e.message);
            }
        }

        console.log('PriceAggregator: retracted ' + snapDeleted + ' price_snapshots + ' + oracleDeleted + ' oracle_prices rows from ' + sourceChain + ' (action_index >= ' + from + (bounded ? ' AND <= ' + to : '') + (fenced ? ' AND push_generation <= ' + gen : '') + ')');
        return { retracted: { price_snapshots: snapDeleted, oracle_prices: oracleDeleted } };
    }
}

module.exports = PriceAggregator;
