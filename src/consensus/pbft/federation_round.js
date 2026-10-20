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
 * XChain Hub - PBFT federation round context
 *
 ********************************************************************/

'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { isFederatedHub, isFederatedHubActive, liveFederationSignals } = require('../federation.js');

const context = new AsyncLocalStorage();

function isFederated(engine) {
    if (engine.minValidators > 1 || engine.validatorSet.length > 1) return true;
    const round = context.getStore();
    return !!round && isFederatedHubActive(engine.hub && engine.hub.network, round.btcBlockHeight) &&
        isFederatedHub(liveFederationSignals(engine));
}

function isFederatedAt(engine, btcBlockHeight) {
    return context.run({ btcBlockHeight }, () => isFederated(engine));
}

function noteBlockHeight(btcBlockHeight) {
    const round = context.getStore();
    if (round) round.btcBlockHeight = btcBlockHeight;
}

function inRound(method, heightFromArgs) {
    return function(...args) {
        const btcBlockHeight = heightFromArgs ? heightFromArgs(args) : null;
        return context.run({ btcBlockHeight }, () => method.apply(this, args));
    };
}

function wrapParts(proposePart, prePreparePart) {
    return [
        Object.assign({}, proposePart, { propose: inRound(proposePart.propose) }),
        Object.assign({}, prePreparePart, {
            handlePrePrepare: inRound(prePreparePart.handlePrePrepare,
                args => args[0] && args[0].data && args[0].data.btcBlockHeight),
        }),
    ];
}

// True when a federated engine's snapshot has members but this hub is not one of them.
// A one-member set also yields getQuorum 0, and only its sole member may act alone over
// it (the DEX soleSelf rule); a hub with no identity counts as a non-member.
function isNonMemberSnapshot(engine, snapshot) {
    if (!engine.isFederated() || !snapshot || !Array.isArray(snapshot.validators) ||
        snapshot.validators.length === 0) return false;
    const self = engine.selfPubkey();
    return !self || !snapshot.validators.some(v => v && String(v.pubkey).toLowerCase() === self);
}

module.exports = { isFederated, isFederatedAt, noteBlockHeight, wrapParts, isNonMemberSnapshot };
