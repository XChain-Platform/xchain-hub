'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Capability-pinned publisher membership uses the shared snapshot and fallback path.

const sinon      = require('sinon');
const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');

const KEY_A = 'aa'.repeat(33);
const KEY_B = 'bb'.repeat(33);
let warn;

function buildPublisher(opts) {
    let queried = { count: 0, params: null };
    let hub = {
        db: { ...DB_METHODS, async doQuery(sql, params) {
            queried.count++;
            queried.params = params;
            return opts.rows || [];
        } },
        network: opts.network,
        capabilitySnapshot: opts.capabilitySnapshot,
        getIdentity: () => null,
        getPeerManager: () => null,
        p2pConfig: {}
    };
    return { publisher: new StateAnchorPublisher(hub), queried };
}

function validators() {
    return { validators: [
        { pubkey: KEY_B.toUpperCase(), source: 'source-1', weight: '1' },
        { pubkey: KEY_B, source: 'source-2', weight: '2' },
        { pubkey: KEY_A, source: 'source-3', weight: '3' }
    ] };
}

function registerSnapshotReadCase() {
    it('reads cross_chain from the gate-selected snapshot and normalizes its pubkeys', async () => {
        let weighted = {
            getWeightSnapshot: sinon.stub().resolves(validators()),
            getSnapshot: sinon.stub().rejects(new Error('count snapshot must not be read'))
        };
        let weightedPub = buildPublisher({ network: 'regtest', capabilitySnapshot: weighted }).publisher;

        expect(await weightedPub.capabilityPubkeysAt('cross_chain', 100)).to.deep.equal([KEY_A, KEY_B]);
        expect(weighted.getWeightSnapshot.calledOnceWithExactly('cross_chain', 100)).to.equal(true);
        expect(weighted.getSnapshot.called).to.equal(false);

        let count = {
            getWeightSnapshot: sinon.stub().rejects(new Error('weight snapshot must not be read')),
            getSnapshot: sinon.stub().resolves(validators())
        };
        let countPub = buildPublisher({ network: 'mainnet', capabilitySnapshot: count }).publisher;

        expect(await countPub.capabilityPubkeysAt('cross_chain', 100)).to.deep.equal([KEY_A, KEY_B]);
        expect(count.getSnapshot.calledOnceWithExactly('cross_chain', 100)).to.equal(true);
        expect(count.getWeightSnapshot.called).to.equal(false);
        expect(warn.called).to.equal(false);
    });
}

function registerFallbackCases() {
    it('uses cross_chain local rows on regtest when the snapshot is unavailable', async () => {
        let capabilitySnapshot = {
            getWeightSnapshot: sinon.stub().resolves(null),
            getSnapshot: sinon.stub().resolves(null)
        };
        let { publisher, queried } = buildPublisher({
            network: 'regtest',
            capabilitySnapshot,
            rows: [
                { signing_pubkey: KEY_B.toUpperCase() },
                { signing_pubkey: KEY_B },
                { signing_pubkey: KEY_A }
            ]
        });

        expect(await publisher.capabilityPubkeysAt('cross_chain', 100)).to.deep.equal([KEY_A, KEY_B]);
        expect(queried.count).to.equal(1);
        expect(queried.params).to.deep.equal([100, 'cross_chain']);
        expect(warn.called).to.equal(false);
    });

    it('off regtest abstains without reading local rows and warns for cross_chain', async () => {
        let capabilitySnapshot = {
            getWeightSnapshot: sinon.stub().resolves(null),
            getSnapshot: sinon.stub().resolves(null)
        };
        let { publisher, queried } = buildPublisher({
            network: 'mainnet',
            capabilitySnapshot,
            rows: [{ signing_pubkey: KEY_A }]
        });

        expect(await publisher.capabilityPubkeysAt('cross_chain', 100)).to.deep.equal([]);
        expect(queried.count).to.equal(0);
        expect(warn.calledOnce).to.equal(true);
        expect(warn.firstCall.args[0]).to.match(/cross_chain membership unresolved at block 100/);
    });
}

function registerOracleRoutingCase() {
    it('routes pinned getActiveOraclePublishPubkeys through oracle_publish capability lookup', async () => {
        let { publisher } = buildPublisher({ network: 'regtest', capabilitySnapshot: null });
        let expected = [KEY_A];
        sinon.stub(publisher, 'capabilityPubkeysAt').resolves(expected);

        let actual = await publisher.getActiveOraclePublishPubkeys(100);

        expect(actual).to.equal(expected);
        expect(publisher.capabilityPubkeysAt.calledOnceWithExactly('oracle_publish', 100)).to.equal(true);
    });
}

describe('StateAnchorPublisher capabilityPubkeysAt', () => {
    beforeEach(() => { warn = sinon.stub(console, 'warn'); });
    afterEach(() => { sinon.restore(); });

    registerSnapshotReadCase();
    registerFallbackCases();
    registerOracleRoutingCase();
});
