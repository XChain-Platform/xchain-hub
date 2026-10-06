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
//
// OraclePublisher: the oracle_publish set it ranks against, its own rank in
// that set, and the DOGE balance it reads before publishing.

const sinon        = require('sinon');
const { expect }   = require('chai');
const { makeIdentity, makeHub, describeOraclePublisher } = require('./helpers/oracle_publisher_harness');


let OraclePublisher;

// Bind this file's OraclePublisher to the module each test loads.
function oraclePublisherTests(title, registerTests) {
    describeOraclePublisher(title, (loaded) => { ({ OraclePublisher } = loaded); }, registerTests);
}


// ── getActiveOraclePublishPubkeys ────────────────────────────────────────

oraclePublisherTests('getActiveOraclePublishPubkeys()', function () {
    it('returns empty array when hub is null', async function () {
        let pub  = new OraclePublisher(makeHub());
        pub.hub  = null;
        let keys = await pub.getActiveOraclePublishPubkeys(100);
        expect(keys).to.deep.equal([]);
    });

    it('uses capability snapshot when available', async function () {
        let capSS = {
            getSnapshot: sinon.stub().resolves({
                validators: [{ pubkey: 'CC'.repeat(32) }, { pubkey: 'BB'.repeat(32) }]
            })
        };
        let hub = makeHub({ capabilitySnapshot: capSS });
        let pub = new OraclePublisher(hub);
        let keys = await pub.getActiveOraclePublishPubkeys(100);
        // Sorted ascending
        expect(keys[0]).to.equal('bb'.repeat(32));
        expect(keys[1]).to.equal('cc'.repeat(32));
    });

    it('fails closed (empty) when the snapshot call throws, never the per-hub registry', async function () {
        // The block-unpinned gossip-driven registry fallback was removed: two hubs
        // resolving different election sets double-anchor / duplicate PRICE v0.
        let capSS = { getSnapshot: sinon.stub().rejects(new Error('indexer down')) };
        let capReg = { getActiveValidators: sinon.stub().resolves(['AA'.repeat(32)]) };
        let hub = makeHub({ capabilitySnapshot: capSS, capabilityRegistry: capReg });
        let pub = new OraclePublisher(hub);
        let keys = await pub.getActiveOraclePublishPubkeys(100);
        expect(keys).to.deep.equal([]);
        expect(capReg.getActiveValidators.called).to.equal(false);
    });

    it('fails closed (empty) when the snapshot resolves no validators, never the registry', async function () {
        let capSS = { getSnapshot: sinon.stub().resolves(null) };
        let capReg = { getActiveValidators: sinon.stub().resolves(['pk1']) };
        let hub = makeHub({ capabilitySnapshot: capSS, capabilityRegistry: capReg });
        let pub = new OraclePublisher(hub);
        let keys = await pub.getActiveOraclePublishPubkeys(100);
        expect(keys).to.deep.equal([]);
        expect(capReg.getActiveValidators.called).to.equal(false);
    });

    it('fails closed (empty) with no snapshot configured', async function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        let keys = await pub.getActiveOraclePublishPubkeys(100);
        expect(keys).to.deep.equal([]);
    });

});


// ── getMyRank ────────────────────────────────────────────────────────────

oraclePublisherTests('getMyRank()', function () {
    it('returns null when no identity', async function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        pub.identity = null;
        let rank = await pub.getMyRank(100);
        expect(rank).to.be.null;
    });

    it('returns rank index when pubkey is in the list', async function () {
        let myPk = 'bb'.repeat(32);
        let capSS = {
            getSnapshot: sinon.stub().resolves({
                validators: [{ pubkey: 'aa'.repeat(32) }, { pubkey: myPk }]
            })
        };
        let hub = makeHub({ capabilitySnapshot: capSS });
        hub.getIdentity = sinon.stub().returns(makeIdentity(myPk));
        let pub = new OraclePublisher(hub);
        let rank = await pub.getMyRank(100);
        expect(rank).to.equal(1); // sorted: aa...=0, bb...=1
    });

    it('returns null when pubkey is not in the validator list', async function () {
        let capSS = {
            getSnapshot: sinon.stub().resolves({
                validators: [{ pubkey: 'cc'.repeat(32) }]
            })
        };
        let hub = makeHub({ capabilitySnapshot: capSS });
        hub.getIdentity = sinon.stub().returns(makeIdentity('dd'.repeat(32)));
        let pub = new OraclePublisher(hub);
        let rank = await pub.getMyRank(100);
        expect(rank).to.be.null;
    });

});


// ── checkBalance ─────────────────────────────────────────────────────────

oraclePublisherTests('checkBalance()', function () {
    it('returns null when no getBalanceFn and no encoder', async function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        let bal = await pub.checkBalance();
        expect(bal).to.be.null;
    });

    it('calls getBalanceFn when set', async function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        pub.getBalanceFn = sinon.stub().resolves(42.5);
        let bal = await pub.checkBalance();
        expect(bal).to.equal(42.5);
    });

    it('returns null when getBalanceFn throws', async function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        pub.getBalanceFn = sinon.stub().rejects(new Error('rpc error'));
        let bal = await pub.checkBalance();
        expect(bal).to.be.null;
    });

    // get_utxos reports `value` in satoshis while lowBalanceThreshold is whole
    // DOGE, so these fixtures carry the real tracker shape (value + the derived
    // `amount` string). A misleading fixture put whole DOGE in `value`, which no
    // tracker emits, and let a 1e8 mis-scale read as correct.
    it('sums encoder UTXOs into a DOGE balance when getBalanceFn is not set', async function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        pub.dogeAddress = 'D123';
        pub.encoder = {
            getUtxos: sinon.stub().resolves([
                { value: '500000000', amount: '5.00000000' },
                { value: '350000000', amount: '3.50000000' }
            ])
        };
        let bal = await pub.checkBalance();
        expect(bal).to.equal(8.5);
    });

    it('converts a UTXO carrying only the satoshi value field', async function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        pub.dogeAddress = 'D123';
        pub.encoder = { getUtxos: sinon.stub().resolves([{ value: '850000000' }]) };
        expect(await pub.checkBalance()).to.equal(8.5);
    });

});

oraclePublisherTests('checkBalance()', function () {

    it('reads a genuinely low wallet as below the floor', async function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        pub.dogeAddress = 'D123';
        pub.encoder = { getUtxos: sinon.stub().resolves([{ value: '400000000', amount: '4.00000000' }]) };
        let bal = await pub.checkBalance();
        expect(bal).to.equal(4);
        expect(bal).to.be.below(pub.lowBalanceThreshold);
    });

    it('handles encoder getUtxos failure by returning null', async function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        pub.dogeAddress = 'D123';
        pub.encoder = {
            getUtxos: sinon.stub().rejects(new Error('encoder error'))
        };
        let bal = await pub.checkBalance();
        expect(bal).to.be.null;
    });

    it('handles non-array UTXO result gracefully', async function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        pub.dogeAddress = 'D123';
        pub.encoder = { getUtxos: sinon.stub().resolves(null) };
        let bal = await pub.checkBalance();
        expect(bal).to.be.null;
    });

});
