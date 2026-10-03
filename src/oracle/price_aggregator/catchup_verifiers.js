'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const hubConfig = require('../../config.js');
const roundIngest = require('./round_ingest.js');
const { validateBatchWindow, validateBatchAnchors, validateBatchRounds,
        refuseUnanchoredOrStraddlingBatch, validateBatchSigs } = require('./batch_validation.js');
const { verifyBatchQuorum } = require('./batch_verification.js');
const { validateOraclePriceIdentity, validateOraclePriceValue,
        validateOraclePriceWireFields, effectiveAtFor } = require('./single_validation.js');
const { registerCatchupVerifier } = require('../../peers/hub_db/catchup_verifiers.js');

const SOURCE_CHAINS = new Set(['BTC', 'LTC', 'DOGE']);

function refuse(reason) {
    return { ok: false, reason };
}

function sameValue(a, b) {
    if (a === null || a === undefined || b === null || b === undefined) return a == null && b == null;
    return String(a) === String(b);
}

function parseProof(raw) {
    if (typeof raw !== 'string') return null;
    try { return JSON.parse(raw); }
    catch (e) { return null; }
}

function aggregatorFrom(context) {
    if (context && context.priceAggregator) return context.priceAggregator;
    return context && context.hub && context.hub.priceAggregator;
}

function admissionColumns(aggregator, admitBlocks) {
    return aggregator.admission.admitBlocksToColumns(admitBlocks === undefined ? null : admitBlocks);
}

function rowHasAdmission(row, columns) {
    return sameValue(row.admit_block_btc, columns.admit_block_btc) &&
        sameValue(row.admit_block_ltc, columns.admit_block_ltc) &&
        sameValue(row.admit_block_doge, columns.admit_block_doge);
}

function matchingPair(row, pairs) {
    return (pairs || []).find(pair => sameValue(pair.pair || pair.coinPair, row.coin_pair) &&
        sameValue(pair.price, row.price));
}

function roundRowMatches(row, sourceChain, roundData, aggregator) {
    if (!sameValue(row.round_number, roundData.round) ||
        !sameValue(row.block_timestamp, roundData.timestamp) ||
        !sameValue(row.reference_block, roundData.block_index) ||
        !sameValue(row.consensus_round, 1) ||
        !sameValue(row.reference_chain, sourceChain) || !sameValue(row.source_chain, sourceChain) ||
        !sameValue(row.source_action_index, roundData.action_index == null ? null : roundData.action_index) ||
        !sameValue(row.push_generation, Number.isFinite(parseInt(roundData.push_generation))
            && parseInt(roundData.push_generation) >= 0 ? parseInt(roundData.push_generation) : 0) ||
        !matchingPair(row, roundData.pairs)) return false;
    return rowHasAdmission(row, admissionColumns(aggregator, roundData.admit_blocks));
}

async function verifyRoundRow(row, context, proof) {
    const aggregator = aggregatorFrom(context);
    const supplied = context && context.priceProof;
    if (!aggregator || !supplied || !supplied.roundData) return refuse('complete signed round unavailable');
    const sourceChain = supplied.sourceChain || row.source_chain;
    const roundData = Object.assign({}, supplied.roundData, { sigs: proof });
    if (!SOURCE_CHAINS.has(sourceChain) || !roundRowMatches(row, sourceChain, roundData, aggregator)) {
        return refuse('row does not match signed round');
    }
    const verified = await roundIngest.verifyValidatedRound.call(aggregator, sourceChain, roundData, false);
    if (!verified.accepted) return refuse(verified.reason);
    if (String(row.consensus_proof) !== JSON.stringify(verified.verifiedSigs) ||
        !sameValue(row.validator_count, verified.verifiedSigs.length)) {
        return refuse('stored round proof is not the verified proof');
    }
    return { ok: true };
}

async function verifyBatchBody(aggregator, sourceChain, batchData) {
    let head = validateBatchWindow.call(aggregator, sourceChain, batchData);
    if (head.reason) return head;
    let anchors = validateBatchAnchors.call(aggregator, batchData);
    if (anchors.reason) return anchors;
    Object.assign(head, anchors);
    let parsed = validateBatchRounds.call(aggregator, batchData, head);
    if (parsed.reason) return parsed;
    let anchorReason = refuseUnanchoredOrStraddlingBatch.call(aggregator, head.btcBlockHeight, parsed.rounds);
    if (anchorReason) return { reason: anchorReason };
    let structural = validateBatchSigs(batchData);
    if (structural.reason) return structural;
    let verified = await verifyBatchQuorum.call(aggregator, structural.sigs, head, parsed.rounds);
    if (verified.reason) return verified;
    return { head, rounds: parsed.rounds, verified };
}

function batchRowMatches(row, sourceChain, batchData, checked, aggregator) {
    const round = checked.rounds.find(item => sameValue(item.round, row.round_number));
    if (!round || !matchingPair(row, round.pairs) ||
        !sameValue(row.block_timestamp, round.timestamp) ||
        !sameValue(row.reference_block, checked.head.referenceBlock) ||
        !sameValue(row.consensus_round, 1) ||
        !sameValue(row.reference_chain, sourceChain) || !sameValue(row.source_chain, sourceChain) ||
        !sameValue(row.source_action_index, batchData.action_index == null ? null : batchData.action_index) ||
        !sameValue(row.batch_block_time, checked.head.blockTime)) return false;
    let generation = parseInt(batchData.push_generation);
    if (!Number.isFinite(generation) || generation < 0) generation = 0;
    if (!sameValue(row.push_generation, generation)) return false;
    return rowHasAdmission(row, admissionColumns(aggregator, round.admitBlocks));
}

async function verifyBatchRow(row, context, proof) {
    const aggregator = aggregatorFrom(context);
    const supplied = context && context.priceProof;
    if (!aggregator || !supplied || !supplied.batchData) return refuse('complete signed batch unavailable');
    const sourceChain = supplied.sourceChain || row.source_chain;
    if (!SOURCE_CHAINS.has(sourceChain)) return refuse('invalid source_chain');
    const batchData = Object.assign({}, supplied.batchData, { sigs: proof.sigs });
    const checked = await verifyBatchBody(aggregator, sourceChain, batchData);
    if (checked.reason) return refuse(checked.reason);
    if (!batchRowMatches(row, sourceChain, batchData, checked, aggregator)) {
        return refuse('row does not match signed batch');
    }
    if (String(row.consensus_proof) !== checked.verified.proofJson ||
        !sameValue(row.validator_count, checked.verified.validatorCount)) {
        return refuse('stored batch proof is not the verified proof');
    }
    return { ok: true };
}

async function verifyPriceSnapshot(row, context) {
    if (!row || typeof row !== 'object' || row.status !== 'finalized') {
        return refuse('price snapshot is not finalized');
    }
    const proof = parseProof(row.consensus_proof);
    if (Array.isArray(proof)) return verifyRoundRow(row, context, proof);
    if (proof && proof.batch && Array.isArray(proof.sigs)) return verifyBatchRow(row, context, proof);
    return refuse('invalid consensus_proof');
}

function oracleRowData(row) {
    return {
        source_address: row.source_address,
        coin: row.coin,
        tick: row.tick,
        fiat: row.fiat,
        value: row.value,
        fee: row.fee,
        memo: row.memo,
        block_time: row.block_time,
        action_index: row.action_index,
        push_generation: row.push_generation
    };
}

function oracleNetwork(context) {
    if (context && context.hub && context.hub.network) return context.hub.network;
    if (context && context.network) return context.network;
    return hubConfig.HUB_NETWORK;
}

async function verifyOraclePrice(row, context) {
    if (!context || typeof context.peer !== 'string' || !context.peer ||
        context.authenticated !== true || context.signerSetPeer !== true) {
        return refuse('oracle price did not arrive from an authenticated signer-set peer');
    }
    if (!row || typeof row !== 'object' || !SOURCE_CHAINS.has(row.source_chain)) {
        return refuse('invalid source_chain');
    }
    const priceData = oracleRowData(row);
    if (!priceData.source_address || !priceData.coin || !priceData.tick || !priceData.fiat || !priceData.value) {
        return refuse('invalid priceData');
    }
    let reason = validateOraclePriceIdentity(priceData);
    if (!reason) reason = validateOraclePriceValue(priceData, oracleNetwork(context), row.source_chain);
    if (reason) return refuse(reason);
    const wire = validateOraclePriceWireFields(priceData);
    if (wire.reason) return refuse(wire.reason);
    if (!sameValue(row.effective_at, effectiveAtFor(parseInt(priceData.block_time, 10)))) {
        return refuse('invalid effective_at');
    }
    if (row.admit_block != null && (!/^[0-9]+$/.test(String(row.admit_block)) ||
        !Number.isSafeInteger(Number(row.admit_block)))) return refuse('invalid admit_block');
    const db = context.db;
    if (!db || typeof db.getPriceIngestWatermark !== 'function') return refuse('generation guard unavailable');
    const network = String(oracleNetwork(context) || '').trim().toLowerCase();
    const watermark = await db.getPriceIngestWatermark(row.source_chain, network);
    if (watermark && wire.pushGeneration <= Number(watermark.retraction_generation) &&
        wire.actionIndex >= Number(watermark.from_action_index)) return refuse('stale (retracted generation)');
    return { ok: true };
}

registerCatchupVerifier('price_snapshots', verifyPriceSnapshot);
registerCatchupVerifier('oracle_prices', verifyOraclePrice);

module.exports = { verifyPriceSnapshot, verifyOraclePrice, verifyBatchBody };
