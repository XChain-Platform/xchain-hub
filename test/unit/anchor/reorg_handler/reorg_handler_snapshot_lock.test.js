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

const sinon = require('sinon');
const { expect } = require('chai');
const ReorgHandler = require('../../../../src/anchor/reorg_handler');
const gateRegistry = require('../../../../src/consensus/gate_registry.js');
const { createMockHub } = require('../../../helpers/mockHub');
const { VALIDATORS_3, VALIDATORS_4, VALIDATORS_7 } = require('../../../helpers/fixtures');

const OLD_HASH = 'a'.repeat(64);
const NEW_HASH = 'b'.repeat(64);
const SNAPSHOT_HEIGHT = 900;
const handlers = [];

function snapshotHub(self, snapshotValidators, options = {}) {
    const registry = new Map(snapshotValidators.map(v => [v.addr, v.pubkey]));
    const hub = createMockHub({
        network: 'regtest',
        validatorAddr: self.addr,
        validatorPubkeys: registry,
        identity: { getPubkeyHex: sinon.stub().returns(self.pubkey) }
    });
    hub.resolveBtcLatestBlock.resolves(SNAPSHOT_HEIGHT);
    hub.capabilitySnapshot = options.withoutSnapshot ? null : {
        getActiveValidatorSnapshot: sinon.stub().callsFake(async height => ({
            capability: '*',
            blockIndex: height,
            count: snapshotValidators.length,
            validators: snapshotValidators.map(v => ({ pubkey: v.pubkey }))
        }))
    };
    hub._peerManager.effectiveSignerSet = new Set(snapshotValidators.map(v => v.pubkey));
    const handler = new ReorgHandler(hub);
    sinon.stub(handler, 'verifyReorgAgainstOwnNode').resolves(true);
    return { hub, handler };
}

function clearRounds(handler) {
    for (const pending of handler.pendingReorgs.values()) {
        if (pending.timer) clearTimeout(pending.timer);
    }
}

function registerSnapshotFormationTests() {
    it('reads its activation from the hub gate registry', function () {
        const key = 'anchor/reorg_handler/snapshot_lock.REORG_SNAPSHOT_ACTIVATION';
        expect(gateRegistry.get(key)).to.deep.equal({
            mainnet: gateRegistry.UNARMED,
            testnet: gateRegistry.UNARMED,
            regtest: 0
        });
    });

    it('locks different live validator lists to one stamped federation quorum', async function () {
        const left = snapshotHub(VALIDATORS_4[0], VALIDATORS_4);
        const right = snapshotHub(VALIDATORS_4[1], VALIDATORS_4);
        handlers.push(left.handler, right.handler);
        left.handler.setValidatorSet(VALIDATORS_3);
        right.handler.setValidatorSet(VALIDATORS_7);

        const timestamp = Date.now();
        await left.handler.reportReorg('BTC', 500, timestamp, OLD_HASH, NEW_HASH);
        await right.handler.reportReorg('BTC', 500, timestamp, OLD_HASH, NEW_HASH);

        const reorgId = `BTC:500:${timestamp}`;
        const leftRound = left.handler.pendingReorgs.get(reorgId);
        const rightRound = right.handler.pendingReorgs.get(reorgId);
        expect(left.handler.getQuorum()).to.equal(2);
        expect(right.handler.getQuorum()).to.equal(5);
        expect(leftRound.quorum).to.equal(3);
        expect(rightRound.quorum).to.equal(3);
        expect(leftRound.btcBlockHeight).to.equal(SNAPSHOT_HEIGHT);
        expect(rightRound.btcBlockHeight).to.equal(SNAPSHOT_HEIGHT);
        expect(leftRound.digest).to.equal(rightRound.digest);
        expect(left.hub._peerManager.broadcast.firstCall.args[1].btcBlockHeight)
            .to.equal(SNAPSHOT_HEIGHT);
    });

    it('refuses a federated regtest round when the stamped snapshot is unavailable', async function () {
        const { handler } = snapshotHub(VALIDATORS_4[0], VALIDATORS_4, { withoutSnapshot: true });
        handlers.push(handler);
        handler.setValidatorSet(VALIDATORS_4);

        let error;
        try {
            await handler.reportReorg('BTC', 500, Date.now(), OLD_HASH, NEW_HASH);
        } catch (err) {
            error = err;
        }

        expect(error).to.be.an('error').with.property('message')
            .that.includes('deterministic stamped federation snapshot');
        expect(handler.pendingReorgs.size).to.equal(0);
    });
}

function registerPrepareVoteTests() {
    it('deduplicates prepare votes by authenticated snapshot pubkey', async function () {
        const { hub, handler } = snapshotHub(VALIDATORS_4[0], VALIDATORS_4);
        handlers.push(handler);
        handler.setValidatorSet(VALIDATORS_7);
        const timestamp = Date.now();
        await handler.reportReorg('BTC', 500, timestamp, OLD_HASH, NEW_HASH);
        const reorgId = `BTC:500:${timestamp}`;
        const pending = handler.pendingReorgs.get(reorgId);
        const prepare = hub._peerManager.broadcast.getCalls()
            .find(call => call.args[0] === 'XCHAIN_REORG_PREPARE').args[1];

        const duplicate = sender => handler.handlePrepare({
            sender,
            sig_pubkey: VALIDATORS_4[1].pubkey,
            data: Object.assign({}, prepare)
        });
        await duplicate(VALIDATORS_4[1].addr);
        await duplicate(VALIDATORS_4[3].addr);

        expect(pending.preparePubkeys.size).to.equal(2);
        expect(pending._commitSent).to.equal(undefined);

        await handler.handlePrepare({
            sender: VALIDATORS_4[2].addr,
            sig_pubkey: VALIDATORS_4[2].pubkey,
            data: Object.assign({}, prepare)
        });

        expect(pending.preparePubkeys.size).to.equal(3);
        expect(pending._commitSent).to.equal(true);
        expect(hub._peerManager.broadcast.lastCall.args[0]).to.equal('XCHAIN_REORG_COMMIT');
        expect(hub._peerManager.broadcast.lastCall.args[1].btcBlockHeight)
            .to.equal(SNAPSHOT_HEIGHT);
    });
}

describe('reorg snapshot lock', function () {
    afterEach(function () {
        for (const handler of handlers) clearRounds(handler);
        handlers.length = 0;
        sinon.restore();
    });

    registerSnapshotFormationTests();
    registerPrepareVoteTests();
});
