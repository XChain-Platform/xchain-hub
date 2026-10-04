'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { PRICE_MAX, PRICE_V1_COINS, PRICE_V1_FIATS,
        MAX_TICK_LENGTH, MAX_MEMO_LENGTH, MAX_SOURCE_ADDRESS_LENGTH } = require('../../constants.js');
const { bcgt } = require('../../bcmath.js');
const { isPriceV1CanonicalActive, isCanonicalPriceV1Value,
        isCanonicalPriceV1Fee } = require('../../consensus/gates/price_scale_gate.js');

function validateOraclePriceIdentity(priceData) {
    if (typeof priceData.source_address !== 'string' || priceData.source_address.length === 0 ||
        priceData.source_address.length > MAX_SOURCE_ADDRESS_LENGTH) return 'invalid source_address';
    if (typeof priceData.coin !== 'string' || !PRICE_V1_COINS.includes(priceData.coin)) return 'invalid coin';
    if (typeof priceData.tick !== 'string' || priceData.tick.length === 0 ||
        priceData.tick.length > MAX_TICK_LENGTH) return 'invalid tick';
    if (typeof priceData.fiat !== 'string' || !PRICE_V1_FIATS.includes(priceData.fiat)) return 'invalid fiat';
    if (priceData.memo !== undefined && priceData.memo !== null &&
        (typeof priceData.memo !== 'string' || priceData.memo.length > MAX_MEMO_LENGTH)) return 'invalid memo';
    return null;
}

function validateOraclePriceValue(priceData, network, coin) {
    if (!/^[0-9]+(\.[0-9]{1,8})?$/.test(String(priceData.value)) || parseFloat(priceData.value) <= 0 ||
        !(parseFloat(priceData.value) < PRICE_MAX)) return 'invalid value';
    if (isPriceV1CanonicalActive(priceData.block_time, network, coin) &&
        !isCanonicalPriceV1Value(priceData.value)) return 'invalid value';
    if (priceData.fee !== undefined && priceData.fee !== null && priceData.fee !== '' &&
        (!/^[0-9]+(\.[0-9]{1,18})?$/.test(String(priceData.fee)) || bcgt(String(priceData.fee), '1'))) {
        return 'invalid fee';
    }
    if (priceData.fee !== undefined && priceData.fee !== null && priceData.fee !== '' &&
        isPriceV1CanonicalActive(priceData.block_time, network, coin) &&
        !isCanonicalPriceV1Fee(priceData.fee)) return 'invalid fee';
    return null;
}

function validateOraclePriceWireFields(priceData) {
    let pushGeneration = parseInt(priceData.push_generation);
    if (!Number.isFinite(pushGeneration) || pushGeneration < 0) pushGeneration = 0;
    if (!/^[0-9]+$/.test(String(priceData.action_index)) ||
        !Number.isSafeInteger(Number(priceData.action_index))) return { reason: 'invalid action_index' };
    if (!/^[0-9]+$/.test(String(priceData.block_time)) ||
        !Number.isSafeInteger(Number(priceData.block_time)) || Number(priceData.block_time) <= 0) {
        return { reason: 'invalid block_time' };
    }
    return { pushGeneration, actionIndex: parseInt(priceData.action_index, 10) };
}

function effectiveAtFor(blockTime) {
    return blockTime + 86400;
}

module.exports = {
    validateOraclePriceIdentity,
    validateOraclePriceValue,
    validateOraclePriceWireFields,
    effectiveAtFor
};
