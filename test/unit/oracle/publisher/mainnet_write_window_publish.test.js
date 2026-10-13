'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mainnet write window: oracle price publishing and attestation batch
// publishing are skipped while mainnetWritesOpen is false.

const { expect } = require('chai');
const sinon = require('sinon');
const { makeHub, describeOraclePublisher } = require('./helpers/oracle_publisher_harness');
const { MAINNET_WRITES_OPEN_AT } = require('../../../../src/lib/mainnet_write_window.js');
const AttestationBatchPublisher = require('../../../../src/attestation/batch_publisher.js');

let OraclePublisher;

describeOraclePublisher('mainnet write window', (loaded) => { ({ OraclePublisher } = loaded); }, function () {
    afterEach(function () { sinon.restore(); });

    it('skips the oracle publish pass on mainnet before the window opens', async function () {
        let pub = new OraclePublisher(makeHub({ network: 'mainnet' }));
        pub.enabled = true;
        sinon.stub(Date, 'now').returns((MAINNET_WRITES_OPEN_AT - 10) * 1000);
        let read = sinon.stub(pub, 'readQueue').returns([{ round: 1 }]);
        await pub.processQueueInner();
        expect(read.called).to.equal(false);
    });

    it('reads the queue on mainnet once the window is open', async function () {
        let pub = new OraclePublisher(makeHub({ network: 'mainnet' }));
        pub.enabled = true;
        sinon.stub(Date, 'now').returns((MAINNET_WRITES_OPEN_AT + 10) * 1000);
        let read = sinon.stub(pub, 'readQueue').returns([]);
        await pub.processQueueInner();
        expect(read.called).to.equal(true);
    });

    it('reads the queue on a non-mainnet network at any time', async function () {
        let pub = new OraclePublisher(makeHub({ network: 'testnet' }));
        pub.enabled = true;
        sinon.stub(Date, 'now').returns(1000);
        let read = sinon.stub(pub, 'readQueue').returns([]);
        await pub.processQueueInner();
        expect(read.called).to.equal(true);
    });
});

describe('AttestationBatchPublisher mainnet write window', function () {
    afterEach(function () { sinon.restore(); });

    function make(network) {
        let pub = Object.create(AttestationBatchPublisher.prototype);
        pub.network = network;
        pub.enabled = true;
        pub._sweeping = false;
        pub.pendingWindows = sinon.stub().resolves([]);
        pub.reconcilePendingAgainstChain = sinon.stub().resolves([]);
        return pub;
    }

    it('skips the sweep on mainnet before the window opens', async function () {
        let pub = make('mainnet');
        let res = await pub.sweep(MAINNET_WRITES_OPEN_AT - 10);
        expect(res.attempted).to.equal(0);
        expect(res.skipped).to.equal('mainnet_window_closed');
        expect(pub.pendingWindows.called).to.equal(false);
    });

    it('sweeps on mainnet once the window is open', async function () {
        let pub = make('mainnet');
        await pub.sweep(MAINNET_WRITES_OPEN_AT + 10);
        expect(pub.pendingWindows.called).to.equal(true);
    });

    it('sweeps on a non-mainnet network at any time', async function () {
        let pub = make('testnet');
        await pub.sweep(5);
        expect(pub.pendingWindows.called).to.equal(true);
    });
});
