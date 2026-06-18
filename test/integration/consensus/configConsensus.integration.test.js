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
const EventEmitter   = require('events');
const testDb         = require('../../helpers/testDb');
const { buildEnvelope } = require('../../helpers/testPeerNetwork');
const { VALIDATORS_1, VALIDATORS_4 } = require('../../helpers/fixtures');
const Consensus      = require('../../../src/Consensus');

function createTestHub(db, validatorAddr) {
    let pm = new EventEmitter();
    pm.validatorAddr    = validatorAddr || 'ws://validator-1:10001';
    pm.validatorPubkeys = new Map();
    pm.broadcast        = sinon.stub().callsFake((type, data) => {
        return { type, id: 'msg-' + Date.now(), sender: pm.validatorAddr, timestamp: Date.now(), data };
    });
    pm.getPeerStatus    = sinon.stub().returns([]);

    let hub = {
        db: db,
        p2pConfig: {},
        getPeerManager: sinon.stub().returns(pm),
        getIdentity:    sinon.stub().returns(null),
        getOracle:      sinon.stub().returns(null),
        getConsensus:   sinon.stub().returns(null),
        getCrossChain:  sinon.stub().returns(null),
        applyConfig:    null,
        _peerManager:   pm
    };

    // applyConfig writes to the real DB
    hub.applyConfig = async function (json) {
        let PARAMETER_LIST = ['host', 'port', 'service_port', 'db_host', 'db_port', 'name', 'user', 'pass'];
        for (let coin in json) {
            if (coin === '') continue;
            for (let network in json[coin]) {
                for (let module in json[coin][network]) {
                    for (let param of PARAMETER_LIST) {
                        let value = json[coin][network][module][param];
                        if (value !== null && value !== undefined) {
                            await db.setParam(coin, network, module, param, value);
                        }
                    }
                }
            }
        }
    };

    return hub;
}

describe('Integration: Config Consensus (SC-6.x)', function () {

    before(async function () {
        try { await testDb.setup(); } catch (e) {
            console.warn('MariaDB unavailable; skipping config consensus tests');
        }
    });

    after(async function () { await testDb.teardown(); });
    beforeEach(async function () {
        if (!testDb.isAvailable()) return this.skip();
        await testDb.truncateAll();
    });
    afterEach(function () { sinon.restore(); });

    // SC-6.1: Config update via PBFT (multi-validator)
    describe('SC-6.1: PBFT config consensus', function () {
        it('applies config after PREPARE and COMMIT quorum', async function () {
            let db = testDb.getDb();
            let hub = createTestHub(db, VALIDATORS_4[0].addr);

            let consensus = new Consensus(hub);
            consensus.setValidatorSet(VALIDATORS_4);
            await consensus.start();

            let config = { BTC: { mainnet: { decoder: { port: '8333' } } } };

            // Leader proposes (returns a promise)
            let proposePromise = consensus.propose(config);

            await new Promise(r => setTimeout(r, 50));

            // Get the pending proposal
            let seq = consensus.seq;
            let pending = consensus.pendingProposals.get(seq);
            expect(pending).to.exist;

            // Inject PREPARE from 2 other validators (quorum = 3 for N=4)
            for (let i = 1; i < 3; i++) {
                hub._peerManager.emit('message', buildEnvelope('PBFT_PREPARE', {
                    seq: seq,
                    configDigest: pending.digest
                }, VALIDATORS_4[i].addr));
            }

            await new Promise(r => setTimeout(r, 50));

            // Inject COMMIT from 2 other validators
            for (let i = 1; i < 3; i++) {
                hub._peerManager.emit('message', buildEnvelope('PBFT_COMMIT', {
                    seq: seq,
                    configDigest: pending.digest
                }, VALIDATORS_4[i].addr));
            }

            let result = await proposePromise;
            expect(result).to.be.true;

            // Verify config persisted in DB
            let stored = await db.getConfig('BTC', 'mainnet', 'decoder');
            expect(stored.port).to.equal('8333');

            // Verify sequence persisted
            let seqRows = await db.doQuery("SELECT value FROM consensus_state WHERE key_name = 'last_seq'");
            expect(seqRows).to.have.lengthOf(1);
            expect(parseInt(seqRows[0].value)).to.equal(seq);

            await consensus.stop();
        });
    });

    // SC-6.2: Config update without P2P (direct write)
    describe('SC-6.2: Single-node config update', function () {
        it('applies config directly when quorum is 0', async function () {
            let db = testDb.getDb();
            let hub = createTestHub(db);

            let consensus = new Consensus(hub);
            consensus.setValidatorSet(VALIDATORS_1);
            await consensus.start();

            let config = { LTC: { testnet: { indexer: { host: 'localhost', port: '3307' } } } };

            let result = await consensus.propose(config);
            expect(result).to.be.true;

            // Verify config persisted
            let stored = await db.getConfig('LTC', 'testnet', 'indexer');
            expect(stored.host).to.equal('localhost');
            expect(stored.port).to.equal('3307');

            await consensus.stop();
        });
    });

    // SC-6.3: Config update with consensus timeout
    describe('SC-6.3: Consensus timeout', function () {
        it('rejects proposal after PBFT timeout and initiates view change', async function () {
            let db = testDb.getDb();
            let hub = createTestHub(db, VALIDATORS_4[0].addr);

            let consensus = new Consensus(hub);
            consensus.setValidatorSet(VALIDATORS_4);
            consensus.timeout = 500; // Short timeout for testing
            await consensus.start();

            let config = { BTC: { mainnet: { decoder: { port: '9999' } } } };

            try {
                await consensus.propose(config);
                expect.fail('Should have thrown on timeout');
            } catch (e) {
                expect(e.message).to.include('Consensus timeout');
            }

            // Verify config was NOT persisted
            let stored = await db.getConfig('BTC', 'mainnet', 'decoder');
            expect(stored.port).to.be.undefined;

            // Verify view change was broadcast
            let viewChangeCalls = hub._peerManager.broadcast.getCalls()
                .filter(c => c.args[0] === 'PBFT_VIEW_CHANGE');
            expect(viewChangeCalls.length).to.be.greaterThan(0);

            await consensus.stop();
        });
    });

    // SC-6.4: Config round-trip via getAllConfigs
    describe('SC-6.4: Config round-trip', function () {
        it('retrieves applied config via getAllConfigs', async function () {
            let db = testDb.getDb();
            let hub = createTestHub(db);

            let consensus = new Consensus(hub);
            consensus.setValidatorSet(VALIDATORS_1);
            await consensus.start();

            // Apply multiple configs
            await consensus.propose({ BTC: { mainnet: { decoder: { host: 'btc-host', port: '8332' } } } });
            await consensus.propose({ LTC: { mainnet: { decoder: { host: 'ltc-host', port: '9332' } } } });

            let all = await db.getAllConfigs();

            expect(all.BTC).to.exist;
            expect(all.BTC.mainnet.decoder.host).to.equal('btc-host');
            expect(all.BTC.mainnet.decoder.port).to.equal('8332');
            expect(all.LTC.mainnet.decoder.host).to.equal('ltc-host');
            expect(all.LTC.mainnet.decoder.port).to.equal('9332');

            await consensus.stop();
        });
    });
});
