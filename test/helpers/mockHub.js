'use strict';

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
        getConfig: sinon.stub().resolves({}),
        getAllConfigs: sinon.stub().resolves({}),
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
        getCrossChain:   sinon.stub().returns(null)
    };

    // Expose the raw stubs for easy test access
    hub._peerManager = overrides.peerManager || peerManager;
    hub._identity    = overrides.identity || identity;

    return hub;
}

module.exports = { createMockHub };
