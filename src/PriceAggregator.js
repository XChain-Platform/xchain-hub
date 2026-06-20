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
                p.price === undefined || p.price === null || !/^[0-9]+(\.[0-9]+)?$/.test(String(p.price))) {
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
            let placeholders = roundData.pairs.map(() => "(?, ?, ?, ?, ?, ?, ?, 1, ?, 'finalized', ?, ?, ?)").join(', ');
            let params = [];
            for (let p of roundData.pairs) {
                params.push(round, p.pair, p.price, referenceBlock, sourceChain || null, timestamp,
                            validatorCount, proofJson, sourceChain || null, sourceActionIndex, createdAt);
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
                    created_at:          createdAt
                });
            }
            let query = `INSERT INTO price_snapshots
                (round_number, coin_pair, price, reference_block, reference_chain, block_timestamp,
                 validator_count, consensus_round, consensus_proof, status, source_chain, source_action_index,
                 created_at)
                VALUES ${placeholders}
                ON DUPLICATE KEY UPDATE
                    price = VALUES(price), reference_block = VALUES(reference_block),
                    reference_chain = VALUES(reference_chain), block_timestamp = VALUES(block_timestamp),
                    validator_count = VALUES(validator_count), consensus_proof = VALUES(consensus_proof),
                    status = 'finalized', source_chain = VALUES(source_chain),
                    source_action_index = VALUES(source_action_index)`;
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
        if (!/^[0-9]+(\.[0-9]{1,8})?$/.test(String(priceData.value)) || parseFloat(priceData.value) <= 0) {
            return { accepted: false, reason: 'invalid value' };
        }
        if (priceData.fee !== undefined && priceData.fee !== null && priceData.fee !== '' &&
            (!/^[0-9]+(\.[0-9]+)?$/.test(String(priceData.fee)) || parseFloat(priceData.fee) > 1)) {
            return { accepted: false, reason: 'invalid fee' };
        }

        let existing = await this.db.doQuery(
            'SELECT id FROM oracle_prices WHERE source_address = ? AND source_chain = ? AND action_index = ? LIMIT 1',
            [priceData.source_address, sourceChain || '', priceData.action_index || 0]
        );
        if (existing && existing.length > 0) {
            return { accepted: false, reason: 'duplicate' };
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

        let query = `INSERT INTO oracle_prices
            (source_address, source_chain, coin, tick, fiat, value, fee, memo, block_time, effective_at, action_index)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        let args = [
            priceData.source_address, sourceChain || '',
            priceData.coin, priceData.tick, priceData.fiat,
            priceData.value, priceData.fee || null, priceData.memo || null,
            blockTime, effectiveAt, priceData.action_index || 0
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
                action_index:   priceData.action_index || 0
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
    async retractFromActionIndex(sourceChain, fromActionIndex) {
        let from = parseInt(fromActionIndex);
        if (!Number.isFinite(from) || from < 0) {
            return { error: 'invalid from_action_index' };
        }

        // price_snapshots tracks the PRICE v0 round action via source_action_index
        let snapResult = await this.db.doQuery(
            'DELETE FROM price_snapshots WHERE source_chain = ? AND source_action_index >= ?',
            [sourceChain, from]
        );
        // oracle_prices tracks the PRICE v1 oracle action via action_index
        let oracleResult = await this.db.doQuery(
            'DELETE FROM oracle_prices WHERE source_chain = ? AND action_index >= ?',
            [sourceChain, from]
        );

        let snapDeleted   = (snapResult   && snapResult.affectedRows   !== undefined) ? Number(snapResult.affectedRows)   : 0;
        let oracleDeleted = (oracleResult && oracleResult.affectedRows !== undefined) ? Number(oracleResult.affectedRows) : 0;

        // Tell the hub DB sync channel to mirror these deletes so distributed
        // indexers prune their local price-table copies too.
        if (snapDeleted > 0) {
            this.emit('row:deleted', {
                table:             'price_snapshots',
                source_chain:      sourceChain,
                from_action_index: from
            });
        }
        if (oracleDeleted > 0) {
            this.emit('row:deleted', {
                table:             'oracle_prices',
                source_chain:      sourceChain,
                from_action_index: from
            });
        }

        console.log('PriceAggregator: retracted ' + snapDeleted + ' price_snapshots + ' + oracleDeleted + ' oracle_prices rows from ' + sourceChain + ' (action_index >= ' + from + ')');
        return { retracted: { price_snapshots: snapDeleted, oracle_prices: oracleDeleted } };
    }
}

module.exports = PriceAggregator;
