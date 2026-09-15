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

const sinon          = require('sinon');
const { expect }     = require('chai');
const proxyquire     = require('proxyquire');
const EventEmitter   = require('events');
// The flag day the silent-slot leader skip rides. Read rather than re-spelled, so
// a height change moves the cases with it instead of leaving them asserting a
// literal the code no longer uses.
const lssMod         = require('../../src/attest_leader_silence_skip_activation.js');
const { DB_METHODS } = require('../helpers/mockHub.js');

const LICENSE_HEADER = ''; // Only needed for file comment; tests use it below

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeIdentity(pubkey) {
    return { getPubkeyHex: () => pubkey || 'aa'.repeat(32) };
}

function makePeerManager() {
    let pm = new EventEmitter();
    pm.broadcast  = sinon.stub();
    pm.sendToPeer = sinon.stub();
    return pm;
}

function makeHub(overrides) {
    let pm = makePeerManager();
    let hub = {
        db:               { ...DB_METHODS, doQuery: sinon.stub().resolves([]) },
        p2pConfig:        overrides && overrides.p2pConfig ? overrides.p2pConfig : {},
        getPeerManager:   () => pm,
        getIdentity:      () => makeIdentity(),
        capabilitySnapshot: overrides && overrides.capabilitySnapshot !== undefined
            ? overrides.capabilitySnapshot : null,
        _resolveBtcIndexerUrl: overrides && overrides._resolveBtcIndexerUrl
            ? overrides._resolveBtcIndexerUrl
            : sinon.stub().resolves(null),
        btcIndexerHeaders: () => ({})
    };
    hub._peerManager = pm;
    return hub;
}

function makeProviderRegistry(overrides) {
    return {
        isKnown:   sinon.stub().returns(true),
        getModule: sinon.stub().returns({ fetch: sinon.stub().resolves({ body: 'data', meta: '200' }) }),
        getDef:    sinon.stub().returns({ max_response_bytes: 32768 }),
        getAdditionalConfig: sinon.stub().returns({ approved_models: ['claude-sonnet-4-6'], judge_model: 'claude-haiku-4-5' }),
        // Block-anchored provider stake floor. '0' keeps the pre-existing
        // fixtures (whose snapshots carry no weight) selecting exactly as before on the
        // unweighted path, which is the only path they exercise.
        getMinStake: sinon.stub().returns('0'),
        // Block-anchored PBFT strategy, resolved once at the request's block and pinned
        // onto roundState. byte_equality keeps the existing fixtures on the path they
        // already exercised; the anchoring itself is covered in ProviderRegistry.test.js
        // and the fail-closed branch below.
        getConsensusStrategy: sinon.stub().returns('byte_equality'),
        ...(overrides || {})
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Load AttestationRound (stub axios)
// ────────────────────────────────────────────────────────────────────────────

let axiosStub;
let AttestationRound;

function loadModule() {
    axiosStub = { post: sinon.stub() };
    AttestationRound = proxyquire('../../src/attestation/round', { axios: axiosStub });
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

{
const hookAt3853 = function () {
        loadModule();
    };

const hookAt3913 = function () {
        sinon.restore();
    };

const path = require('path');

const DOCS_DIR = process.env.XCHAIN_DOCS_DIR
            || path.join(__dirname, '..', '..', '..', 'xchain-documentation');

const VEC_PATH = path.join(DOCS_DIR, 'protocol', 'test-vectors', 'responsible_set.json');

let vec = null, vecErr = null;

const hookAt16564 = function () {
            if (vec) return;
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the responsible-set canonical vectors are unloadable at '
                    + VEC_PATH + ' (' + (vecErr && vecErr.message) + ')');
            this.skip();
        };

const AttestationPublisher = require('../../src/attestation/publisher.js');

const os   = require('os');

// ── responsible-set cross-service conformance ────────────────────────────
    // CONSENSUS-CRITICAL: _computeResponsibleSet is implemented independently
    // here and in xchain-indexer (actions/attest/index.js). They must produce
    // identical ordered output or attestation quorum evaluation forks. This
    // guard runs the canonical vectors from xchain-documentation against the
    // hub copy; the indexer ships its own mirror guard over the SAME vector
    // file. When the sibling xchain-documentation repo is not checked out
    // (standalone deploy) the suite skips rather than fails, matching the
    // ConsensusPrimitiveConformance convention - but in the required-siblings lane
    // (XCHAIN_REQUIRE_SIBLINGS=1, set by bin/ci-all.sh) an unresolvable vector path
    // is a hard failure, so a mis-resolved path cannot turn this consensus guard
    // into a permanent green-by-skip (item 2435).


        // AttestationPublisher._computeResponsible is the SECOND hub-side copy of the
        // same rule (it derives failover rank from it). Running the same vectors through
        // it closes the gap this describe's header once named: until now no test fed
        // one input through more than one copy, so the two could drift in a direction
        // both suites called green. It returns null rather than [] where the rule
        // selects nobody, which is the caller's "rank unknown" signal.
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('_computeResponsibleSet() canonical-vector conformance @regression', function () { try {
            vec = require(VEC_PATH);
        } catch (e) { vecErr = e; } before(hookAt16564); describe('AttestationPublisher._computeResponsible over the same vectors', function () { (vec ? vec.computeResponsibleSet : []).forEach(function (c) {
                it(c.name, async function () {
                    const fresh = () => c.validators.map(v => Object.assign({}, v));
                    const pub = new AttestationPublisher({
                        getIdentity: () => ({ getPubkeyHex: () => 'ff'.repeat(32) }),
                        p2pConfig:   {},
                        network:     c.weighted ? 'regtest' : 'mainnet',
                        capabilitySnapshot: {
                            getWeightSnapshot: async () => ({ validators: fresh() }),
                            getSnapshot:       async () => ({ validators: fresh() })
                        },
                        providerRegistry: { getMinStake: () => (c.minStake === undefined ? null : c.minStake) }
                    });
                    pub.queuePath = path.join(os.tmpdir(),
                        'attest-vec-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.jsonl');
                    // Block 100: below the mainnet SWQ anchor (961000) and above the
                    // regtest one (0), so the vector's `weighted` flag alone picks the branch.
                    let got = await pub._computeResponsible(c.requestId, 100, c.redundancy, 'http_get');
                    expect(got).to.deep.equal(c.expected.length ? c.expected : null);
                });
            }); }); }); });
}
