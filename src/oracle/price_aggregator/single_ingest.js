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
 * XChain Hub - Price Aggregator: PRICE v1 user oracle ingest
 *
 * The unsigned rail: one user's on-chain oracle price, validated against the
 * indexer's wire-format rules, fenced against a stale replay, stamped with the
 * uniform 24h effective_at delay and stored under the generation-monotonic upsert.
 *
 ********************************************************************/

const { validateOraclePriceIdentity, validateOraclePriceValue,
        validateOraclePriceWireFields, effectiveAtFor } = require('./single_validation.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

// HUB-RETRACT-4: reject a stale replay of a rolled-back PRICE action. A fire-and-forget v1
// push that failed and was re-enqueued, or an in-flight HTTP push, can land AFTER the reorg
// retraction that deleted its row, still carrying the pre-reorg generation. The ingest fence
// rejects any push whose generation <= the chain's processed retraction generation AND whose
// action_index sits in that retraction's orphaned range; the re-published canonical row
// carries a higher generation (or a below-orphan action_index) and passes. No watermark row
// exists until the first retraction, so genuine pre-reorg generation-0 pushes are never hit.
function ingestWatermarkRead(sourceChain) {
    return this.db.getPriceIngestWatermark(sourceChain || '', this.fenceNetwork());
}

// Dedupe by (source_address, source_chain, action_index). A strictly NEWER-generation push
// at a recycled action_index is NOT a duplicate: it is the canonical re-publication and must
// supersede a stale row that escaped retraction (the monotonic upsert below overwrites only
// when strictly newer). An equal-or-older generation is a true idempotent duplicate.
function oraclePriceDedupeRead(priceData, sourceChain, actionIndex) {
    return this.db.getOraclePrice(priceData.source_address, sourceChain || '', actionIndex);
}

// Generation-monotonic upsert (HUB-RETRACT-4): on the (source_chain, action_index) unique
// key, a lower-or-equal generation never overwrites a newer row, so a late stale push can
// neither insert an orphan (fenced above) nor clobber the canonical re-publication here.
//
// admit_block rides the same generation guard as every other column: a re-published
// row at a recycled action_index carries the NEW ingest's height, and a stale replay
// can never move the height a live reader has already bound against. The statement,
// its assignment order and its positional binding live in db.setOraclePriceByGeneration.
function oraclePriceUpsert(priceData, sourceChain, stamps) {
    return this.db.setOraclePriceByGeneration({
        source_address:  priceData.source_address,
        source_chain:    sourceChain || '',
        coin:            priceData.coin,
        tick:            priceData.tick,
        fiat:            priceData.fiat,
        value:           priceData.value,
        fee:             priceData.fee || null,
        memo:            priceData.memo || null,
        block_time:      stamps.blockTime,
        effective_at:    stamps.effectiveAt,
        action_index:    stamps.actionIndex,
        push_generation: stamps.pushGeneration,
        admit_block:     stamps.admitBlock
    });
}

// Mirror the stored row and say what was accepted.
function announceOraclePrice(priceData, sourceChain, stamps) {
    // Emit row event so the hub DB sync channel can broadcast to subscribers
    this.emit('row:inserted', {
        table: 'oracle_prices',
        origin: 'chain-ingest',
        row: {
            source_address: priceData.source_address,
            source_chain:   sourceChain || '',
            coin:           priceData.coin,
            tick:           priceData.tick,
            fiat:           priceData.fiat,
            value:          priceData.value,
            fee:            priceData.fee || null,
            memo:           priceData.memo || null,
            block_time:     stamps.blockTime,
            effective_at:   stamps.effectiveAt,
            action_index:   stamps.actionIndex,   // the validated integer, matching the stored row
            admit_block:    stamps.admitBlock,    // null is the legacy row, and it binds by effective_time
            push_generation: stamps.pushGeneration
        }
    });

    logger.info('PriceAggregator: accepted PRICE v1 from ' + priceData.source_address + ' (' + priceData.coin + '/' + priceData.tick + '/' + priceData.fiat + ' = ' + priceData.value + ', effective_at=' + stamps.effectiveAt + ')');
}

module.exports = {

    async receiveOraclePrice(sourceChain, priceData) {
        if (!priceData || !priceData.source_address || !priceData.coin || !priceData.tick || !priceData.fiat || !priceData.value) {
            return { accepted: false, reason: 'invalid priceData' };
        }

        let identityReason = validateOraclePriceIdentity(priceData);
        if (identityReason) return { accepted: false, reason: identityReason };

        let valueReason = validateOraclePriceValue(priceData, this.hub && this.hub.network, sourceChain);
        if (valueReason) return { accepted: false, reason: valueReason };

        let wire = validateOraclePriceWireFields(priceData);
        if (wire.reason) return { accepted: false, reason: wire.reason };
        let { pushGeneration, actionIndex } = wire;

        let wm = await ingestWatermarkRead.call(this, sourceChain);
        if (wm && pushGeneration <= wm.retraction_generation && actionIndex >= wm.from_action_index) {
            // Never silent: a rebuilt indexer trips this fence on every push.
            this.warnIngestFenceRejection(sourceChain, 'PRICE v1 oracle', pushGeneration, actionIndex, wm);
            return { accepted: false, reason: 'stale (retracted generation)' };
        }

        let existing = await oraclePriceDedupeRead.call(this, priceData, sourceChain, actionIndex);
        if (existing && existing.length > 0) {
            let existingGen = parseInt(existing[0].push_generation) || 0;
            if (pushGeneration <= existingGen) {
                return { accepted: false, reason: 'duplicate' };
            }
            // else fall through: a newer generation supersedes the stale row via the upsert.
        }

        let blockTime = parseInt(priceData.block_time, 10);   // gated above; never coerced to 0
        let effectiveAt = effectiveAtFor(blockTime);

        // THE ADMISSION HEIGHT for this row (R5 (a)), resolved from THIS hub's own ingest
        // because nothing else can: a PRICE v1 action is user-submitted, carries no
        // signatures and no canonical, and its wire payload carries no block HEIGHT at all.
        // NULL on every failure, never 0: a legacy row binds by effective_time at every
        // height, which is the fail-closed direction, while a zero would admit the row at a
        // block every live chain passed years ago.
        let admitBlock = await this.resolveOracleAdmitBlock(sourceChain);

        let stamps = { blockTime, effectiveAt, actionIndex, pushGeneration, admitBlock };
        try {
            await oraclePriceUpsert.call(this, priceData, sourceChain, stamps);
        } catch (err) {
            logger.error(nodeUtil.format('PriceAggregator: error inserting oracle price:', err));
            return { accepted: false, reason: 'db error' };
        }

        announceOraclePrice.call(this, priceData, sourceChain, stamps);
        return { accepted: true };
    }

};

require('./catchup_verifiers.js');
