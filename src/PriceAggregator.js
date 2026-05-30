/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
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
 * locally. The hub is the cross-chain aggregation point — first valid
 * submission for a given round wins, duplicates are silently ignored.
 *
 ********************************************************************/

const EventEmitter = require('events');

class PriceAggregator extends EventEmitter {

    constructor(hub) {
        super();
        this.hub = hub;
        this.db  = hub.db;
    }

    // Receive a validated PRICE v0 round from an indexer
    // sourceChain: chain on which the PRICE tx was published
    // roundData:   { round, timestamp, pairs, sigs, action_index, block_index }
    // Returns: { accepted, reason } where reason is 'duplicate' or 'error' if rejected
    async receiveValidatedRound(sourceChain, roundData) {
        if (!roundData || !roundData.round || !Array.isArray(roundData.pairs)) {
            return { accepted: false, reason: 'invalid roundData' };
        }

        let round = parseInt(roundData.round);
        if (!Number.isFinite(round) || round < 0) {
            return { accepted: false, reason: 'invalid round' };
        }

        // Dedupe: if any row exists for this round_number, this is a duplicate
        let existing = await this.db.doQuery(
            'SELECT id FROM price_snapshots WHERE round_number = ? LIMIT 1',
            [round]
        );
        if (existing && existing.length > 0) {
            return { accepted: false, reason: 'duplicate' };
        }

        let proofJson = JSON.stringify(roundData.sigs || []);
        let validatorCount = Array.isArray(roundData.sigs) ? roundData.sigs.length : 0;
        let timestamp = parseInt(roundData.timestamp) || 0;
        let referenceBlock = parseInt(roundData.block_index) || round;
        let sourceActionIndex = roundData.action_index || null;

        // Insert one row per pair
        // Capture a single hub-side timestamp before the loop so all pairs in this round
        // share the same created_at and it propagates to operators via the WS broadcast row.
        let createdAt = new Date();
        let insertedRows = [];
        for (let p of roundData.pairs) {
            if (!p || !p.pair || !p.price) continue;
            let query = `INSERT INTO price_snapshots
                (round_number, coin_pair, price, reference_block, reference_chain, block_timestamp,
                 validator_count, consensus_round, consensus_proof, status, source_chain, source_action_index,
                 created_at)
                VALUES (?, ?, ?, ?, 'BTC', ?, ?, 1, ?, 'finalized', ?, ?, ?)`;
            let args = [round, p.pair, p.price, referenceBlock, timestamp,
                        validatorCount, proofJson, sourceChain || 'DOGE', sourceActionIndex,
                        createdAt];
            try {
                await this.db.doQuery(query, args);
                insertedRows.push({
                    round_number:        round,
                    coin_pair:           p.pair,
                    price:               p.price,
                    reference_block:     referenceBlock,
                    reference_chain:     'BTC',
                    block_timestamp:     timestamp,
                    validator_count:     validatorCount,
                    consensus_round:     1,
                    consensus_proof:     proofJson,
                    status:              'finalized',
                    source_chain:        sourceChain || 'DOGE',
                    source_action_index: sourceActionIndex,
                    created_at:          createdAt
                });
            } catch (err) {
                console.error('PriceAggregator: error inserting snapshot for round ' + round + ' pair ' + p.pair + ':', err.message);
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

    // Receive a validated PRICE v1 user oracle price from an indexer
    // sourceChain: chain on which the PRICE tx was published
    // priceData:   { source_address, coin, tick, fiat, value, fee, memo, block_time, action_index }
    // Returns: { accepted, reason }
    async receiveOraclePrice(sourceChain, priceData) {
        if (!priceData || !priceData.source_address || !priceData.coin || !priceData.tick || !priceData.fiat || !priceData.value) {
            return { accepted: false, reason: 'invalid priceData' };
        }

        // Dedupe by (source_address, source_chain, action_index)
        let existing = await this.db.doQuery(
            'SELECT id FROM oracle_prices WHERE source_address = ? AND source_chain = ? AND action_index = ? LIMIT 1',
            [priceData.source_address, sourceChain || '', priceData.action_index || 0]
        );
        if (existing && existing.length > 0) {
            return { accepted: false, reason: 'duplicate' };
        }

        // Determine effective_at: first broadcast for this oracle/coin/tick/fiat is immediate;
        // subsequent updates are delayed by 24h to prevent front-running attacks on dispensers.
        let blockTime = parseInt(priceData.block_time) || 0;
        let prior = await this.db.doQuery(
            'SELECT id FROM oracle_prices WHERE source_address = ? AND coin = ? AND tick = ? AND fiat = ? LIMIT 1',
            [priceData.source_address, priceData.coin, priceData.tick, priceData.fiat]
        );
        let effectiveAt = (prior && prior.length > 0) ? blockTime + 86400 : blockTime;

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
            console.error('PriceAggregator: error inserting oracle price:', err.message);
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
