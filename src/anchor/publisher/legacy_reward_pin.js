/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * ANCHOR publisher - the indexer's LEGACY_ANCHOR_REWARD_PIN rule, read by the reward drain
 *
 * The indexer judges the gate on the time of the BTC block that derives a reward, which does
 * not exist yet when the drain runs. Every BTC block is timed after the median time past of
 * the blocks before it, so a median at or past the instant proves the gate on at every later
 * block. Short of that proof the drain keeps its old verdict and never forfeits a reward.
 *
 ********************************************************************/

'use strict';

const { activeAt } = require('../../consensus/gate_registry.js');
const { loadLegacyRewardPins } = require('../legacy_reward_pins.js');

// The hub row mirroring the time columns of the indexer's protocol change.
const LEGACY_PIN_GATE = 'anchor/publisher/legacy_reward_pin.LEGACY_ANCHOR_REWARD_PIN';
// Bitcoin's median-time-past window, in blocks.
const MTP_SPAN = 11;
// Read the median this many blocks below the tip, so a shallow reorg cannot undo a proof.
const TIP_MARGIN = 6;
// Bitcoin refuses a block timed over two hours past the receiving node's clock.
const MAX_FUTURE_BLOCK_S = 7200;
// The pre-restart wire bytes the gate stops from proving a reward.
const LEGACY_BYTES = [6, 7];

// The vendored pin list, read once at first use.
let pins = null;

// Does this anchor set carry a pre-restart wire byte, the only rows the gate changes the verdict on?
function hasLegacyByteRow(anchors){
    return Array.isArray(anchors) && anchors.some(a => a && LEGACY_BYTES.includes(Number(a.version)));
}

// Is this drain entry a tuple legacy_reward_pins.json pins, spelled as the indexer's proveRow spells it?
function isPinnedEntry(e){
    if(pins === null) pins = loadLegacyRewardPins();
    return pins.isPinned({
        reward_type: e.rewardType, round_reference: Number(e.roundReference),
        snapshot_block: Number(e.snapshotBlock), publisher: String(e.publisher || '').toLowerCase(),
        txid: String(e.txid || '').toLowerCase()
    });
}

// The BTC block at `height` from this hub's BTC indexer, or null unless it answers for that block on `network`.
async function blockAt(indexerCall, network, height, tip){
    let bh = (Number(tip.block_index) === height) ? tip
        : await indexerCall('BTC', 'getblockhashes', { block_index: height });
    if(!bh || Number(bh.block_index) !== height || String(bh.network) !== network) return null;
    return bh;
}

// The median time past ending at `height`, or null when any of its eleven block times is unreadable.
async function medianTimePast(indexerCall, network, height, tip){
    let times = [];
    for(let h = height - MTP_SPAN + 1; h <= height; h++){
        let bh = await blockAt(indexerCall, network, h, tip);
        let t = bh ? bh.block_time : null;
        // Only a whole number of seconds is a block time; null, '' and garbage read as unprovable.
        if(!(typeof t === 'number' || (typeof t === 'string' && /^[0-9]+$/.test(t)))) return null;
        if(!Number.isSafeInteger(Number(t))) return null;
        times.push(Number(t));
    }
    times.sort((a, b) => a - b);
    return times[(MTP_SPAN - 1) / 2];
}

// Is the gate proven on at every BTC block that can still derive a reward on `network`?
// `provenFrom` maps a network to the lowest height already proven, which no later height can undo.
// Returns false, never throws, when the proof cannot be made: the caller then keeps its old verdict.
async function legacyPinGateProven(indexerCall, network, provenFrom, nowS){
    // An unarmed network, or an instant no block can have reached yet, reads no BTC block at all.
    if(!activeAt(LEGACY_PIN_GATE, network, null, null, nowS + MAX_FUTURE_BLOCK_S)) return false;
    let tip = await indexerCall('BTC', 'getblockhashes', {});
    if(!tip || String(tip.network) !== network) return false;
    let height = Number(tip.block_index) - TIP_MARGIN;
    if(!Number.isSafeInteger(height) || height < MTP_SPAN - 1) return false;
    let known = provenFrom.get(network);
    if(known !== undefined && height >= known) return true;
    let mtp = await medianTimePast(indexerCall, network, height, tip);
    if(mtp === null || !activeAt(LEGACY_PIN_GATE, network, null, null, mtp)) return false;
    provenFrom.set(network, known === undefined ? height : Math.min(known, height));
    return true;
}

module.exports = { LEGACY_PIN_GATE, hasLegacyByteRow, isPinnedEntry, legacyPinGateProven, medianTimePast };
