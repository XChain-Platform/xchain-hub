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
 * XChain Hub - federation membership helper
 *
 * Pure predicate answering "is this hub part of a real federation" from the
 * four signals a hub can observe. It strictly widens PBFT's isFederated
 * (minValidators > 1 || validatorSet.length > 1): every input that function
 * calls federated is federated here too, and a hub that has open non-observer
 * peers or configured SEED_NODES is also federated even while its own
 * validator set is still empty or size one.
 */

'use strict';

const hubConfig = require('../config');
const gateRegistry = require('./gate_registry.js');

const GATE_KEY = 'consensus/federation.FEDERATED_HUB_ACTIVATION';

function count(value) {
    if (Array.isArray(value)) return value.length;
    if (Number.isInteger(value) && value > 0) return value;
    return 0;
}

function seedCount(seedNodes) {
    const list = typeof seedNodes === 'string' ? seedNodes.split(',') : seedNodes;
    if (!Array.isArray(list)) return 0;
    return list.filter(s => typeof s === 'string' && s.trim() !== '').length;
}

function isFederatedHub({ minValidators, validators, peers, seedNodes } = {}) {
    const min = Number(minValidators);
    if (Number.isFinite(min) && min > 1) return true;
    if (count(validators) > 1) return true;
    if (count(peers) > 0) return true;
    return seedCount(seedNodes) > 0;
}

// Whether the widened federation test governs a round pinned at `height`. The
// height is the round's own BTC anchor, so every hub reads the same answer for
// the same round; a missing or unparseable height reads as inactive.
function isFederatedHubActive(network, height) {
    return gateRegistry.activeAt(GATE_KEY,
        String(network || '').toLowerCase(), null, height, null);
}

// The four signals read off a live engine: its configured floor, its validator
// set, its open peers and the configured seeds.
function liveFederationSignals(engine) {
    const manager = engine.peerManager;
    const status = manager && typeof manager.getPeerStatus === 'function' ? manager.getPeerStatus() : [];
    return {
        minValidators: engine.minValidators,
        validators: engine.validatorSet,
        peers: status.filter(p => p && p.state === 'open'),
        seedNodes: hubConfig.SEED_NODES,
    };
}

module.exports = { isFederatedHub, isFederatedHubActive, liveFederationSignals };
