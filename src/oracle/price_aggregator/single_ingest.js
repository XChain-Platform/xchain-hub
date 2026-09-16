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

const { PRICE_MAX, PRICE_V1_COINS, PRICE_V1_FIATS,
        MAX_TICK_LENGTH, MAX_MEMO_LENGTH, MAX_SOURCE_ADDRESS_LENGTH } = require('../../constants.js');
const { bcgt }          = require('../../bcmath.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

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
function validateOraclePriceIdentity(priceData) {
    if (typeof priceData.source_address !== 'string' || priceData.source_address.length === 0 ||
        priceData.source_address.length > MAX_SOURCE_ADDRESS_LENGTH) {
        return 'invalid source_address';
    }
    if (typeof priceData.coin !== 'string' || !PRICE_V1_COINS.includes(priceData.coin)) {
        return 'invalid coin';
    }
    if (typeof priceData.tick !== 'string' || priceData.tick.length === 0 || priceData.tick.length > MAX_TICK_LENGTH) {
        return 'invalid tick';
    }
    if (typeof priceData.fiat !== 'string' || !PRICE_V1_FIATS.includes(priceData.fiat)) {
        return 'invalid fiat';
    }
    if (priceData.memo !== undefined && priceData.memo !== null &&
        (typeof priceData.memo !== 'string' || priceData.memo.length > MAX_MEMO_LENGTH)) {
        return 'invalid memo';
    }
    return null;
}

// The value and the optional FEE, on the indexer's own bounds.
function validateOraclePriceValue(priceData) {
    if (!/^[0-9]+(\.[0-9]{1,8})?$/.test(String(priceData.value)) || parseFloat(priceData.value) <= 0 ||
        !(parseFloat(priceData.value) < PRICE_MAX)) {   // PRICE_MAX ceiling at ingest (item 9e6c0acd)
        return 'invalid value';
    }
    // FEE upper bound uses exact bcmath, not parseFloat: an unbounded-precision
    // value like '1.0000000000000000001' rounds to exactly 1.0 under IEEE-754 and
    // would slip past a parseFloat `> 1` gate while exact math treats it as > 1.
    // Mirrors the indexer's price-action FEE validation (wire-format parity).
    if (priceData.fee !== undefined && priceData.fee !== null && priceData.fee !== '' &&
        (!/^[0-9]+(\.[0-9]{1,18})?$/.test(String(priceData.fee)) || bcgt(String(priceData.fee), '1'))) {
        return 'invalid fee';
    }
    return null;
}

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
//
// block_time is the base of the uniform 24h effective_at delay documented below;
// coercing it to 0 produced effective_at 86400 (1970-01-02), which the
// `effective_at <= now` read path serves immediately, i.e. the delay silently off.
// Deliberately NOT bounded to a recency window against the hub clock: a rebuilt indexer
// replays history and pushes genuine old block_times (see the fence warning above), so a
// freshness bound would reject exactly the backfill the durable outbox exists to deliver.
function validateOraclePriceWireFields(priceData) {
    // Source-chain reorg fence (item 5308): the generation the source indexer carried on
    // this push (0 when absent/malformed). See receiveValidatedRound.
    let pushGeneration = parseInt(priceData.push_generation);
    if (!Number.isFinite(pushGeneration) || pushGeneration < 0) pushGeneration = 0;

    if (!/^[0-9]+$/.test(String(priceData.action_index)) ||
        !Number.isSafeInteger(Number(priceData.action_index))) {
        return { reason: 'invalid action_index' };
    }
    if (!/^[0-9]+$/.test(String(priceData.block_time)) ||
        !Number.isSafeInteger(Number(priceData.block_time)) ||
        Number(priceData.block_time) <= 0) {
        return { reason: 'invalid block_time' };
    }
    return { pushGeneration, actionIndex: parseInt(priceData.action_index, 10) };
}

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

// Determine effective_at: every publish (first or update) is delayed by 24h
// from its action's block_time. The delay on updates prevents front-running
// attacks on dispensers. The delay on first publishes exists for consensus:
// an immediate first publish was retroactively effective (effective_at =
// block_time, which precedes the row's arrival in any hub/mirror by the
// source chain's indexing lag), so a FIAT dispense settled live could replay
// differently once the row existed (a ledger fork). A uniform +24h makes
// every row land in every mirror long before any block can read it, which
// is also what makes the hub-db sync stream watermark a sound barrier.
function effectiveAtFor(blockTime) {
    return blockTime + 86400;
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

        let valueReason = validateOraclePriceValue(priceData);
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
