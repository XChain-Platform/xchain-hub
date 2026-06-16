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
// Finding F1 (standing-federation Phase 1, 2026-06-11): registerValidator
// reloaded the validator set into the config-PBFT engine only. Engines that
// were running with a different (e.g. boot-time-empty) set developed
// divergent leader views — a hub restarted into such a federation rejected
// legitimate proposals ("PROPOSE from non-leader") and silently missed
// every round whose expected leader never proposes. These tests pin the
// propagate-to-every-engine behavior for both registerValidator and
// syncValidators.

const sinon      = require('sinon');
const { expect } = require('chai');
const XChainHub  = require('../../src/XChainHub');

describe('XChainHub — validator-set propagation (F1)', function () {

    const PUBKEY = 'ab'.repeat(32);
    const SET    = [{ addr: 'ws://v1:10001', signing_pubkey: 'aa'.repeat(32) }];

    let hub, engines;

    function stubEngine() { return { setValidatorSet: sinon.stub(), setChainPairValidators: sinon.stub() }; }

    beforeEach(function () {
        hub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
        hub.db = { doQuery: sinon.stub().resolves([]) };
        sinon.stub(hub, '_loadValidatorSet').resolves(SET);
        sinon.stub(hub, '_loadValidatorPubkeys').resolves();
        sinon.stub(hub, '_loadChainPairValidators').resolves({ 'BTC-LTC': [] });

        engines = {
            consensus:       stubEngine(),
            oracleConsensus: stubEngine(),
            crossChain:      stubEngine(),
            reorgHandler:    stubEngine(),
            governance:      stubEngine(),
        };
        Object.assign(hub, engines);
    });

    afterEach(function () { sinon.restore(); });

    it('registerValidator propagates the reloaded set to EVERY running engine', async function () {
        await hub.registerValidator(PUBKEY, 'ws://new-validator:10009');

        for (let [name, eng] of Object.entries(engines)) {
            expect(eng.setValidatorSet.calledOnceWith(SET), name + '.setValidatorSet').to.be.true;
        }
        expect(engines.crossChain.setChainPairValidators.calledOnce).to.be.true;
    });

    it('syncValidators routes through the same propagation', async function () {
        await hub.syncValidators([{ signing_pubkey: PUBKEY, addr: 'ws://v9:10009' }]);

        for (let [name, eng] of Object.entries(engines)) {
            expect(eng.setValidatorSet.calledOnceWith(SET), name + '.setValidatorSet').to.be.true;
        }
    });

    it('rotateValidator routes through the same propagation', async function () {
        // The addr-existence SELECT must return a current active row.
        hub.db.doQuery = sinon.stub().resolves([{ signing_pubkey: 'cc'.repeat(32) }]);
        await hub.rotateValidator('ws://v1:10001', PUBKEY);

        for (let [name, eng] of Object.entries(engines)) {
            expect(eng.setValidatorSet.calledOnceWith(SET), name + '.setValidatorSet').to.be.true;
        }
    });

    it('rotateValidator on an unknown addr throws (no active row) and does NOT propagate', async function () {
        // Default stub resolves [] → addr-check finds no active validator.
        let threw = false;
        try { await hub.rotateValidator('ws://unknown:10001', PUBKEY); }
        catch (e) { threw = true; expect(e.message).to.include('No active validator'); }
        expect(threw, 'should throw').to.be.true;
        expect(engines.consensus.setValidatorSet.called).to.be.false;
    });

    it('deregisterValidator routes through the same propagation', async function () {
        await hub.deregisterValidator({ signingPubkey: PUBKEY });

        for (let [name, eng] of Object.entries(engines)) {
            expect(eng.setValidatorSet.calledOnceWith(SET), name + '.setValidatorSet').to.be.true;
        }
    });

    it('skips engines that are not running (standalone mode)', async function () {
        hub.oracleConsensus = null;
        hub.crossChain      = null;
        hub.reorgHandler    = null;
        hub.governance      = null;

        await hub.registerValidator(PUBKEY, 'ws://new-validator:10009');
        expect(engines.consensus.setValidatorSet.calledOnce).to.be.true;
        // No throw = pass for the null engines.
    });
});
