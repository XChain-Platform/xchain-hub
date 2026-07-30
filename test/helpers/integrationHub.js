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

// ONE hub stand-in for the DB-backed integration tier.
//
// Every integration file used to carry its own private `createTestHub`, four
// near-identical copies that each had to be remembered whenever XChainHub grew a
// method its subsystems call. They were not remembered. `_resolveBtcNetwork`
// (read by OracleRound at the top of every round) existed on only one of them, so
// each round threw, the chain-tip anchor went to fallback, and finalization was
// suppressed - which surfaced as six unrelated-looking oracle and dispenser
// failures rather than as "the fixture is missing a method" .
//
// So: one definition, and a check that keeps it honest. HUB_SURFACE below lists
// the members the hub must expose for the subsystems under test; assertHubSurface
// compares it against the real XChainHub prototype, so a rename on the product
// side fails loudly here instead of degrading into a behavioural mystery.

const sinon        = require('sinon');
const EventEmitter = require('events');
const XChainHub    = require('../../src/XChainHub');
const { bftQuorumOrSingle } = require('../../src/lib/bft_quorum.js');

// Members of the real hub that integration subsystems call on their fixture.
// Keep this list in step with what the fixture actually provides.
const HUB_SURFACE = [
    'getPeerManager', 'getIdentity', 'getOracle', 'getConsensus', 'getCrossChain',
    'applyConfig', '_resolveBtcNetwork', '_resolveBtcLatestBlock'
];

// Shared p2pConfig floor. ORACLE_EPOCH_START is required (OracleRound's
// constructor throws without it: every hub in a federation must agree on the
// epoch), the rest just keep round timings short enough for a test.
const P2P_CONFIG_DEFAULTS = {
    ORACLE_EPOCH_START:            1704067200000, // 2024-01-01 UTC
    ORACLE_ROUND_INTERVAL:         1000,
    ORACLE_SUBMISSION_WINDOW:      500,
    ORACLE_REWARD_PER_ROUND:       '10.00000000',
    SLASH_DEVIATION_THRESHOLD:     '0.05',
    SLASH_MISSED_ROUNDS_THRESHOLD: '30',
    PRICE_FETCH_TIMEOUT:           5000
};

/**
 * Fail loudly when the real hub no longer carries a member the fixture fakes.
 * Called on every createIntegrationHub(), so the whole tier reports the drift.
 */
function assertHubSurface() {
    let missing = HUB_SURFACE.filter(name => typeof XChainHub.prototype[name] !== 'function');
    if (missing.length > 0) {
        throw new Error(
            'integrationHub: XChainHub no longer defines ' + missing.join(', ') +
            '. The fixture fakes these; update HUB_SURFACE and the fake together, ' +
            'or the tier will fake a method the product does not have.'
        );
    }
}

/**
 * A capability-snapshot stand-in that seats an exact validator set at any block.
 *
 * CrossChainEngine._resolveQuorum fails CLOSED without one: a federated hub
 * (live quorum > 0) that cannot resolve a deterministic cross_chain snapshot
 * refuses to attest rather than fork N against its peers. Multi-validator
 * integration tests must therefore supply this, not just a validator set.
 *
 * @param {Array} validators - fixture validators ({ addr, pubkey })
 */
function createCapabilitySnapshotStub(validators) {
    let members = validators.map(v => ({ addr: v.addr, pubkey: v.pubkey }));
    return {
        getSnapshot: sinon.stub().callsFake(async (capability, blockIndex) => ({
            capability, blockIndex,
            count:      members.length,
            validators: members
        })),
        getWeightSnapshot: sinon.stub().resolves(null),
        getActiveValidatorSnapshot: sinon.stub().callsFake(async (blockIndex) => ({
            capability: 'active', blockIndex,
            count:      members.length,
            validators: members
        })),
        getActiveWeightSnapshot: sinon.stub().resolves(null),
        getQuorum:   (snapshot) => bftQuorumOrSingle(snapshot ? snapshot.count : 0, 0),
        isInSnapshot: (snapshot, pubkey) => !!snapshot && snapshot.validators.some(
            v => String(v.pubkey).toLowerCase() === String(pubkey).toLowerCase())
    };
}

/**
 * Build a hub stand-in wired to a real Database instance.
 *
 * @param {Object} db            - a live src/db.js instance (testDb.getDb())
 * @param {string} validatorAddr - this node's own validator addr
 * @param {Object} overrides     - p2pConfig, identity, applyConfig,
 *                                 capabilitySnapshot, btcNetwork, btcLatestBlock
 */
function createIntegrationHub(db, validatorAddr, overrides = {}) {
    assertHubSurface();

    let pm = new EventEmitter();
    pm.validatorAddr    = validatorAddr || 'ws://validator-1:10001';
    pm.validatorPubkeys = new Map();
    pm.broadcast        = sinon.stub().callsFake((type, data) => ({
        type, id: 'msg-' + Date.now(), sender: pm.validatorAddr, timestamp: Date.now(), data
    }));
    pm.sendToPeer    = sinon.stub().returns(true);
    pm.getPeerStatus = sinon.stub().returns([]);

    let identity = ('identity' in overrides)
        ? overrides.identity
        : { getPubkeyHex: () => '01'.repeat(32), sign: () => 'aa'.repeat(64) };

    let hub = {
        db:             db,
        p2pConfig:      { ...P2P_CONFIG_DEFAULTS, ...(overrides.p2pConfig || {}) },
        getPeerManager: sinon.stub().returns(pm),
        getIdentity:    sinon.stub().returns(identity),
        getOracle:      sinon.stub().returns(null),
        getConsensus:   sinon.stub().returns(null),
        getCrossChain:  sinon.stub().returns(null),
        applyConfig:    overrides.applyConfig || sinon.stub().resolves(),
        // The two resolvers OracleRound and CrossChainEngine reach for on the real
        // hub. btcNetwork defaults to 'mainnet' (what the real resolver returns when
        // no BTC indexer is configured); btcLatestBlock defaults to null, which is
        // the "no indexer reachable" answer and keeps single-node paths on their
        // round-number anchor.
        _resolveBtcNetwork:     sinon.stub().resolves(overrides.btcNetwork || 'mainnet'),
        _resolveBtcLatestBlock: sinon.stub().resolves(
            'btcLatestBlock' in overrides ? overrides.btcLatestBlock : null),
        _peerManager:   pm
    };

    if (overrides.capabilitySnapshot) hub.capabilitySnapshot = overrides.capabilitySnapshot;

    return hub;
}

/**
 * Register mocha hooks that put the process into single-validator oracle mode.
 *
 * OracleConsensus reads ORACLE_MIN_SUBMISSIONS from process.env ONLY (default 2:
 * one hub's single external source must never become a federation-signed price).
 * A one-validator round therefore stores a 'skipped' snapshot instead of a
 * finalized one. Setting the knob in a fixture's p2pConfig looks right and does
 * nothing, which is exactly the trap that was in place here.
 *
 * Call at describe scope in any suite that drives a real single-validator round.
 */
function useSingleValidatorOracleEnv() {
    let saved;
    before(function () {
        saved = process.env.ORACLE_MIN_SUBMISSIONS;
        process.env.ORACLE_MIN_SUBMISSIONS = '1';
    });
    after(function () {
        if (saved === undefined) delete process.env.ORACLE_MIN_SUBMISSIONS;
        else process.env.ORACLE_MIN_SUBMISSIONS = saved;
    });
}

module.exports = {
    createIntegrationHub, createCapabilitySnapshotStub, useSingleValidatorOracleEnv, HUB_SURFACE
};
