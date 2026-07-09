'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const sinon        = require('sinon');
const EventEmitter = require('events');

/**
 * Create a mock hub object suitable for injecting into any xchain-hub class.
 * Every dependency is a sinon stub so callers can assert on interactions.
 */
function createMockHub(overrides = {}) {
    let db = {
        doQuery: sinon.stub().resolves([]),
        setParam: sinon.stub().resolves(),
        setParams: sinon.stub().resolves(0),
        getConfig: sinon.stub().resolves({}),
        getAllConfigs: sinon.stub().resolves({}),
        // OracleRound reads the BTC chain tip to anchor each round. Default to
        // null (tip unavailable) so the round falls back to its round-number
        // anchor without throwing; tests needing a real tip override this.
        getChainTip: sinon.stub().resolves(null),
        // HUB-RETRACT-4 price ingest fence. Default: no watermark recorded, so ingest
        // never rejects (pre-fix behaviour); tests that exercise the fence override
        // getPriceIngestWatermark to return a {retraction_generation, from_action_index}.
        getPriceIngestWatermark: sinon.stub().resolves(null),
        bumpPriceIngestWatermark: sinon.stub().resolves(),
        close: sinon.stub().resolves()
    };

    let peerManager        = new EventEmitter();
    peerManager.validatorAddr    = overrides.validatorAddr || 'ws://validator-1:10001';
    peerManager.validatorPubkeys = overrides.validatorPubkeys || new Map();
    peerManager.broadcast        = sinon.stub().returns({ id: 'msg-1' });
    peerManager.sendToPeer       = sinon.stub().returns(true);
    peerManager.getPeerStatus    = sinon.stub().returns([]);

    let identity = {
        getPubkeyHex:  sinon.stub().returns('aa'.repeat(32)),
        sign:          sinon.stub().returns('bb'.repeat(64)),
        signEnvelope:  sinon.stub().returns('cc'.repeat(64))
    };

    // Default ORACLE_EPOCH_START so OracleRound's constructor doesn't reject
    // tests that don't care about epoch semantics. Tests that need a specific
    // anchor can override via p2pConfig.ORACLE_EPOCH_START.
    let p2pConfigDefaults = { ORACLE_EPOCH_START: 1704067200000 }; // 2024-01-01 UTC
    let hub = {
        db:              overrides.db || db,
        p2pConfig:       { ...p2pConfigDefaults, ...(overrides.p2pConfig || {}) },
        getPeerManager:  sinon.stub().returns(overrides.peerManager || peerManager),
        getIdentity:     sinon.stub().returns(overrides.identity || identity),
        applyConfig:     sinon.stub().resolves(),
        getOracle:       sinon.stub().returns(null),
        getConsensus:    sinon.stub().returns(null),
        getCrossChain:   sinon.stub().returns(null),
        // OracleRound._executeRound resolves the BTC network via the hub before
        // reading the chain tip to anchor a round; default to mainnet. Tests that
        // exercise chain-tip-fallback behaviour can override this stub.
        _resolveBtcNetwork:      sinon.stub().resolves('mainnet'),
        _resolveBtcLatestBlock:  sinon.stub().resolves(null)
    };

    // Expose the raw stubs for easy test access
    hub._peerManager = overrides.peerManager || peerManager;
    hub._identity    = overrides.identity || identity;

    return hub;
}

module.exports = { createMockHub };
