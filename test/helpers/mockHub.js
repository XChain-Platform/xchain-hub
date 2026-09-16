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

const fs           = require('fs');
const path         = require('path');
const sinon        = require('sinon');
const EventEmitter = require('events');
const Database     = require('../../src/db');

/**
 * Every named query method the db mixins install, as a plain object.
 *
 * A test double is an object carrying a doQuery stub. Now that a query lives in
 * a mixin method rather than at its call site, the engine calls db.findX() and a
 * bare double answers "findX is not a function", which says nothing about the
 * code under test. Spreading this into a double gives it the real methods, and
 * each of them calls this.doQuery, so the stub still sees the same statements
 * with the same args in the same order. Spread it FIRST in the literal so every
 * member the double declares itself still wins.
 *
 * Read off src/db/ rather than off Database.prototype, because the prototype
 * also carries the class's own connection and migration methods and handing a
 * double a real getConnection would let a unit test reach for a server.
 */
const DB_METHODS = {};
const DB_DIR = path.join(__dirname, '..', '..', 'src', 'db');
// A family that grew into a directory is read through its index.js; a directory
// without one (schema/) is the class's own plumbing and stays out of the double.
for (const e of fs.readdirSync(DB_DIR, { withFileTypes: true })) {
    const f = e.isDirectory() ? path.join(e.name, 'index.js') : e.name;
    if (f === 'index.js' || !f.endsWith('.js') || !fs.existsSync(path.join(DB_DIR, f))) continue;
    Object.assign(DB_METHODS, require(path.join(DB_DIR, f)));
}
delete DB_METHODS.doQuery;

/**
 * Create a mock hub object suitable for injecting into any xchain-hub class.
 * Every dependency is a sinon stub so callers can assert on interactions.
 */
function createMockHub(overrides = {}) {
    // Built ON Database.prototype rather than as a bare object, so every named
    // query method the mixins define is present and routes through the doQuery
    // stub below. The stub's callCount and getCall(i).args therefore still
    // assert the same statements, in the same order, that they asserted when
    // the SQL sat at the call site.
    let db = Object.assign(Object.create(Database.prototype), {
        doQuery: sinon.stub().resolves([]),
        setParam: sinon.stub().resolves(),
        setParams: sinon.stub().resolves(0),
        getConfig: sinon.stub().resolves({}),
        getAllConfigs: sinon.stub().resolves({}),
        // OracleRound reads the BTC chain tip to anchor each round. Default to
        // null (tip unavailable) so the round falls back to its round-number
        // anchor without throwing; tests needing a real tip override this.
        getChainTip: sinon.stub().resolves(null),
        // HUB-RETRACT-4 price ingest fence, keyed (network, source_chain). Default: no
        // watermark recorded, so ingest never rejects (pre-fix behaviour); tests that
        // exercise the fence override getPriceIngestWatermark to return a
        // {retraction_generation, from_action_index}. Both accessors take the hub's own
        // network as their last argument; assert on it via the stub's call args.
        getPriceIngestWatermark: sinon.stub().resolves(null),
        bumpPriceIngestWatermark: sinon.stub().resolves(),
        close: sinon.stub().resolves()
    });

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
        // The hub's own deployment network. Left undefined by default so activation
        // helpers see exactly what they saw before this key existed; tests that care
        // about network scoping (the price ingest fence) pass one in.
        network:         overrides.network,
        p2pConfig:       { ...p2pConfigDefaults, ...(overrides.p2pConfig || {}) },
        getPeerManager:  sinon.stub().returns(overrides.peerManager || peerManager),
        getIdentity:     sinon.stub().returns(overrides.identity || identity),
        applyConfig:     sinon.stub().resolves(),
        getOracle:       sinon.stub().returns(null),
        getConsensus:    sinon.stub().returns(null),
        getCrossChain:   sinon.stub().returns(null),
        // OracleRound.executeRound resolves the BTC network via the hub before
        // reading the chain tip to anchor a round; default to mainnet. Tests that
        // exercise chain-tip-fallback behaviour can override this stub.
        resolveBtcNetwork:      sinon.stub().resolves('mainnet'),
        resolveBtcLatestBlock:  sinon.stub().resolves(null)
    };

    // Expose the raw stubs for easy test access
    hub._peerManager = overrides.peerManager || peerManager;
    hub._identity    = overrides.identity || identity;

    return hub;
}

module.exports = { createMockHub, DB_METHODS };
