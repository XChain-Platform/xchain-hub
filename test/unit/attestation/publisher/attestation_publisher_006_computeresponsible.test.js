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
 * XChain Hub - AttestationPublisher unit tests
 *
 * Covers: constructor defaults, start/stop lifecycle, buildAttestationResponseWire,
 * _enqueue/readQueue/rewriteQueue/removeFromQueue, getBroadcaster, _myRank,
 * _computeResponsible, fetchPendingRequestIds, _resolveBtcIndexerUrl,
 * defaultBroadcast, onRequestFinalized edge cases (no-sigs, oversized payload).
 *
 ********************************************************************/

'use strict';

const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const sinon = require('sinon');
const nock  = require('nock');
const { expect } = require('chai');
const AttestationPublisher = require('../../../../src/attestation/publisher');
const { waitUntil } = require('../../../helpers/waitUntil');
const { DB_METHODS } = require('../../../helpers/mockHub.js');

const MY_PUB     = 'aa'.repeat(32);
const LEADER_PUB = 'bb'.repeat(32);
const OTHER_PUB  = 'cc'.repeat(32);

// ---------- hub factory (mirrors AttestationPublisherReplay pattern) --------

function makeHub(myPub, overrides) {
    overrides = overrides || {};
    return Object.assign({
        getIdentity: () => ({ getPubkeyHex: () => myPub }),
        p2pConfig: {},
        attestationConsensus: null,
        capabilitySnapshot: {
            getSnapshot: async () => ({ validators: [{ pubkey: myPub }, { pubkey: LEADER_PUB }] })
        },
        _resolveBtcIndexerUrl: async () => 'http://indexer.local/rpc',
        btcIndexerHeaders: () => ({})
    }, overrides);
}

// Create a publisher with a unique tmpdir queue path per test.
function makePublisher(myPub, hubOverrides) {
    const pub = new AttestationPublisher(makeHub(myPub || MY_PUB, hubOverrides));
    pub.queuePath = path.join(os.tmpdir(), 'attest-pub-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.jsonl');
    return pub;
}

function writeQueue(file, entries) {
    fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

function readQueue(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

// ---------- constructor --------------------------------------------------

// ---------- setBroadcastHook / setWalletSignHook / setEncoder ---------------

// ---------- start / stop ----------------------------------------------------

// ---------- buildAttestationResponseWire ------------------------------------

// ---------- _enqueue / readQueue / rewriteQueue / removeFromQueue --------

// ---------- getBroadcaster -------------------------------------------------

// ---------- _myRank ---------------------------------------------------------

// ---------- _computeResponsible ---------------------------------------------

// ---------- _resolveBtcIndexerUrl -------------------------------------------

// ---------- fetchPendingRequestIds -----------------------------------------

// ---------- onRequestFinalized edge cases -----------------------------------

// ---------- _processQueue extra paths not covered by replay suite -----------

// ---------- defaultBroadcast -----------------------------------------------

// ---------- items 2674 / 2676 / 2678 / 2681: effector-safety guards ----------

// ── attest_published_requests retention (#4869) ────────────────────────────────
// The durable marker table gained one row per paid ATTEST request and never lost
// one, so a money-bearing broadcast path grew a table without bound while its
// oracle_published_rounds sibling was swept. Retention may only ever touch
// CONFIRMED rows (a sent_at NULL row is the quarantine marker an operator
// reconciles by hand), may never touch a request still on the durable WAL, and may
// never reach inside the horizon in which a live path can still surface the
// request, which is the longest provider deadline_window_blocks.

{
const hookAt28895 = function () { sinon.restore(); };

// ---- provider stake floor --------------------------------------
    // This ordering only drives failover step-in timing, but ranking against a set
    // AttestationRound and the indexer do not agree with means followers step in
    // early or the true rank-1 steps in late. So the third copy applies the floor too.

    function weightedHub(validators, minStake) {
        return {
            network: 'regtest',                       // SWQ armed at genesis
            capabilitySnapshot: { getWeightSnapshot: async () => ({ validators }) },
            providerRegistry: { getMinStake: () => minStake }
        };
    }

const RICH = [
        { pubkey: MY_PUB,    source: 'sA', weight: '50000' },
        { pubkey: LEADER_PUB, source: 'sB', weight: '9999.99999999' },
        { pubkey: OTHER_PUB, source: 'sC', weight: '10000' }
    ];

describe('AttestationPublisher: _computeResponsible', function () { afterEach(hookAt28895); it('returns null when capabilitySnapshot is not available', async function () {
        const pub = makePublisher(MY_PUB, { capabilitySnapshot: null });
        const result = await pub._computeResponsible('req' + '00'.repeat(30), 100, 2);
        expect(result).to.be.null;
    }); });

describe('AttestationPublisher: _computeResponsible', function () { afterEach(hookAt28895); it('returns null when snapshot returns no validators', async function () {
        const pub = makePublisher(MY_PUB, {
            capabilitySnapshot: { getSnapshot: async () => ({ validators: [] }) }
        });
        const result = await pub._computeResponsible('req' + '00'.repeat(30), 100, 2);
        expect(result).to.be.null;
    }); });

describe('AttestationPublisher: _computeResponsible', function () { afterEach(hookAt28895); it('returns null when snapshot returns null', async function () {
        const pub = makePublisher(MY_PUB, {
            capabilitySnapshot: { getSnapshot: async () => null }
        });
        const result = await pub._computeResponsible('req' + '00'.repeat(30), 100, 2);
        expect(result).to.be.null;
    }); });

describe('AttestationPublisher: _computeResponsible', function () { afterEach(hookAt28895); it('returns a sorted slice of pubkeys based on SHA256(rid || pubkey)', async function () {
        const validators = [MY_PUB, LEADER_PUB, OTHER_PUB].map(pk => ({ pubkey: pk }));
        const pub = makePublisher(MY_PUB, {
            capabilitySnapshot: { getSnapshot: async () => ({ validators }) }
        });
        const rid = '11'.repeat(32);
        const result = await pub._computeResponsible(rid, 100, 2);
        expect(Array.isArray(result)).to.equal(true);
        expect(result.length).to.equal(2);
        // All results should be known pubkeys
        for (const pk of result) {
            expect([MY_PUB, LEADER_PUB, OTHER_PUB]).to.include(pk);
        }
    }); });

describe('AttestationPublisher: _computeResponsible', function () { afterEach(hookAt28895); it('is deterministic (same inputs → same ordering)', async function () {
        const validators = [MY_PUB, LEADER_PUB, OTHER_PUB].map(pk => ({ pubkey: pk }));
        const pub = makePublisher(MY_PUB, {
            capabilitySnapshot: { getSnapshot: async () => ({ validators }) }
        });
        const rid = 'deadbeef'.repeat(8);
        const r1 = await pub._computeResponsible(rid, 100, 3);
        const r2 = await pub._computeResponsible(rid, 100, 3);
        expect(r1).to.deep.equal(r2);
    }); });

describe('AttestationPublisher: _computeResponsible', function () { afterEach(hookAt28895); it('returns null when getSnapshot throws', async function () {
        const pub = makePublisher(MY_PUB, {
            capabilitySnapshot: { getSnapshot: async () => { throw new Error('DB down'); } }
        });
        const result = await pub._computeResponsible('req' + '00'.repeat(30), 100, 2);
        expect(result).to.be.null;
    }); });

describe('AttestationPublisher: _computeResponsible', function () { afterEach(hookAt28895); it('limits result to redundancy (max 1 when redundancy=1)', async function () {
        const validators = [MY_PUB, LEADER_PUB, OTHER_PUB].map(pk => ({ pubkey: pk }));
        const pub = makePublisher(MY_PUB, {
            capabilitySnapshot: { getSnapshot: async () => ({ validators }) }
        });
        const result = await pub._computeResponsible('11'.repeat(32), 100, 1);
        expect(result.length).to.equal(1);
    }); });

describe('AttestationPublisher: _computeResponsible', function () { afterEach(hookAt28895); it('drops below-floor sources on the weighted path', async function () {
        const pub = makePublisher(MY_PUB, weightedHub(RICH, '10000'));
        const result = await pub._computeResponsible('11'.repeat(32), 100, 3, 'http_get');
        expect(result).to.have.members([MY_PUB, OTHER_PUB]);
        expect(result).to.not.include(LEADER_PUB);
    }); });

describe('AttestationPublisher: _computeResponsible', function () { afterEach(hookAt28895); it('returns null when the provider floor cannot be resolved', async function () {
        const pub = makePublisher(MY_PUB, weightedHub(RICH, null));
        expect(await pub._computeResponsible('11'.repeat(32), 100, 3, 'http_get')).to.be.null;
    }); });

describe('AttestationPublisher: _computeResponsible', function () { afterEach(hookAt28895); it('returns null when the floor excludes every source', async function () {
        const pub = makePublisher(MY_PUB, weightedHub(RICH, '999999'));
        expect(await pub._computeResponsible('11'.repeat(32), 100, 3, 'http_get')).to.be.null;
    }); });

describe('AttestationPublisher: _computeResponsible', function () { afterEach(hookAt28895); it('does not consult the floor below the STAKE_WEIGHTED_QUORUM gate', async function () {
        // network mainnet + block 100 is far below the 961000 anchor, so the unweighted
        // snapshot runs and its weightless rows must still select normally.
        const pub = makePublisher(MY_PUB, {
            network: 'mainnet',
            capabilitySnapshot: { getSnapshot: async () => ({ validators: [{ pubkey: MY_PUB }, { pubkey: LEADER_PUB }] }) },
            providerRegistry: { getMinStake: () => { throw new Error('must not be consulted below the gate'); } }
        });
        const result = await pub._computeResponsible('11'.repeat(32), 100, 2, 'http_get');
        expect(result).to.have.lengthOf(2);
    }); });

describe('AttestationPublisher: _computeResponsible', function () { afterEach(hookAt28895); it('returns null on the weighted path when the event carried no provider id', async function () {
        // Fail closed: without a provider id this copy cannot resolve the same floor the
        // other three do, so ranking against an unfiltered set would be worse than not
        // ranking at all (the caller falls back to event.leaderPubkey).
        const pub = makePublisher(MY_PUB, weightedHub(RICH, '10000'));
        expect(await pub._computeResponsible('11'.repeat(32), 100, 3)).to.be.null;
    }); });
}
