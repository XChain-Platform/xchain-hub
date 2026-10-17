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

const sinon = require('sinon');
const { expect } = require('chai');
const ReorgHandler = require('../../../../src/anchor/reorg_handler');
const {
    REORG_ALERT,
    XCHAIN_REORG_PREPARE,
    XCHAIN_REORG_COMMIT
} = require('../../../../src/anchor/reorg_handler/message_types.js');
const snapshotLock = require('../../../../src/anchor/reorg_handler/snapshot_lock.js');
const { createMockHub } = require('../../../helpers/mockHub');
const { VALIDATORS_4 } = require('../../../helpers/fixtures');

const NEW_HASH = 'f'.repeat(64);
const OLD_HASHES = ['a', 'b', 'c'].map(value => value.repeat(64));
const REORG_HEIGHT = 500;
const NOW = 1700000000000;

function snapshotHub(self, network, btcBlockHeight) {
    const registry = new Map(VALIDATORS_4.map(validator => [validator.addr, validator.pubkey]));
    const hub = createMockHub({
        network,
        validatorAddr: self.addr,
        validatorPubkeys: registry,
        identity: { getPubkeyHex: sinon.stub().returns(self.pubkey) }
    });
    hub.resolveBtcLatestBlock.resolves(btcBlockHeight);
    hub.capabilitySnapshot = {
        getActiveValidatorSnapshot: sinon.stub().callsFake(async height => ({
            capability: '*',
            blockIndex: height,
            count: VALIDATORS_4.length,
            validators: VALIDATORS_4.map(validator => ({ pubkey: validator.pubkey }))
        }))
    };
    hub._peerManager.effectiveSignerSet = new Set(VALIDATORS_4.map(validator => validator.pubkey));
    const handler = new ReorgHandler(hub);
    handler.setValidatorSet(VALIDATORS_4);
    handler.timeout = 25;
    sinon.stub(handler, 'verifyReorgAgainstOwnNode').resolves(true);
    sinon.stub(handler, 'executeRollback').resolves();
    return { hub, handler };
}

function fourHubs(network, btcBlockHeight) {
    const nodes = VALIDATORS_4.map(validator => snapshotHub(validator, network, btcBlockHeight));
    const honest = nodes.slice(1);
    const queue = [];
    const broadcastTypes = new Set([XCHAIN_REORG_PREPARE, XCHAIN_REORG_COMMIT]);

    for (const node of honest) {
        node.hub._peerManager.broadcast.callsFake((type, data) => {
            if (broadcastTypes.has(type)) {
                queue.push({
                    source: node,
                    envelope: {
                        type,
                        sender: node.hub._peerManager.validatorAddr,
                        sig_pubkey: node.hub._identity.getPubkeyHex(),
                        data: Object.assign({}, data)
                    }
                });
            }
            return { id: 'routed-message' };
        });
    }

    return {
        nodes,
        honest,
        async drain() {
            while (queue.length > 0) {
                const message = queue.shift();
                for (const recipient of honest) {
                    if (recipient !== message.source)
                        await recipient.handler.handleMessage(message.envelope);
                }
            }
        }
    };
}

async function sendByzantineAlerts(cluster, btcBlockHeight) {
    const reporter = cluster.nodes[0];
    const reorgId = `BTC:${REORG_HEIGHT}:${NOW}`;
    await Promise.all(cluster.honest.map((node, index) => node.handler.handleMessage({
        type: REORG_ALERT,
        sender: reporter.hub._peerManager.validatorAddr,
        sig_pubkey: reporter.hub._identity.getPubkeyHex(),
        data: {
            chain: 'BTC',
            reorgHeight: REORG_HEIGHT,
            timestamp: NOW,
            reorgId,
            oldHash: OLD_HASHES[index],
            newHash: NEW_HASH,
            btcBlockHeight
        }
    })));
    return reorgId;
}

describe('reorg digest v2 multi-hub regression with four hubs', function () {
    let clock;

    beforeEach(function () {
        clock = sinon.useFakeTimers({ now: NOW });
    });

    afterEach(function () {
        clock.restore();
        sinon.restore();
    });

    it('fragments Byzantine oldHash variants below the gate and never reaches quorum', async function () {
        const btcBlockHeight = snapshotLock.REORG_SNAPSHOT_ACTIVATION.testnet;
        const cluster = fourHubs('testnet', btcBlockHeight);
        const timeouts = cluster.honest.map(node => {
            const events = [];
            node.handler.on('reorg:timeout', event => events.push(event));
            return events;
        });
        const reorgId = await sendByzantineAlerts(cluster, btcBlockHeight);

        await cluster.drain();

        const rounds = cluster.honest.map(node => node.handler.pendingReorgs.get(reorgId));
        expect(new Set(rounds.map(round => round.digest)).size).to.equal(3);
        for (const [index, round] of rounds.entries()) {
            expect(round.oldHash).to.equal(OLD_HASHES[index]);
            expect(round.quorum).to.equal(3);
            expect(round.preparePubkeys.size).to.equal(1);
            expect(round._commitSent).to.equal(undefined);
        }
        expect(cluster.honest.map(node => node.handler.executeRollback.callCount))
            .to.deep.equal([0, 0, 0]);
        expect(cluster.honest.map(node => node.hub._peerManager.broadcast.getCalls()
            .filter(call => call.args[0] === XCHAIN_REORG_COMMIT).length))
            .to.deep.equal([0, 0, 0]);

        await clock.tickAsync(26);

        expect(timeouts.map(events => events.length)).to.deep.equal([1, 1, 1]);
        expect(timeouts.map(events => events[0].prepares)).to.deep.equal([1, 1, 1]);
        expect(cluster.honest.every(node => !node.handler.pendingReorgs.has(reorgId))).to.equal(true);
    });

    it('converges at the gate and each honest hub executes rollback exactly once', async function () {
        const cluster = fourHubs('regtest', 0);
        const reorgId = await sendByzantineAlerts(cluster, 0);

        await cluster.drain();

        const prepareDigests = cluster.honest.map(node => {
            const call = node.hub._peerManager.broadcast.getCalls()
                .find(item => item.args[0] === XCHAIN_REORG_PREPARE);
            return call.args[1].digest;
        });
        expect(new Set(prepareDigests).size).to.equal(1);
        expect(cluster.honest.map(node => node.handler.executeRollback.callCount))
            .to.deep.equal([1, 1, 1]);
        for (const node of cluster.honest) {
            expect(node.handler.executeRollback.firstCall.args[3]).to.equal(reorgId);
            expect(node.handler.executeRollback.firstCall.args[4]).to.equal(3);
            const proof = JSON.parse(node.handler.executeRollback.firstCall.args[5]);
            expect(proof).to.have.length(3);
            expect(proof).to.not.include(VALIDATORS_4[0].pubkey);
            expect(node.hub._peerManager.broadcast.getCalls()
                .filter(call => call.args[0] === XCHAIN_REORG_COMMIT)).to.have.length(1);
        }
        expect(cluster.nodes[0].handler.executeRollback.callCount).to.equal(0);
    });
});
