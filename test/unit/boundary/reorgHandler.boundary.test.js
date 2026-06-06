'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const sinon          = require('sinon');
const { expect }     = require('chai');
const ReorgHandler   = require('../../../src/ReorgHandler');
const { createMockHub }               = require('../../helpers/mockHub');
const { makeValidator, VALIDATORS_4 } = require('../../helpers/fixtures');

describe('Boundary: ReorgHandler', function () {

    let hub, pm, rh;

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        rh  = new ReorgHandler(hub);
    });

    afterEach(function () {
        for (let [, pending] of rh.pendingReorgs) {
            if (pending.timer) clearTimeout(pending.timer);
        }
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // Height boundaries
    // -----------------------------------------------------------------

    describe('reorg height boundaries', function () {

        it('reorg at height 0 is valid and triggers rollback', async function () {
            rh.setValidatorSet([]);
            pm.getPeerStatus.returns([]);

            await rh.reportReorg('BTC', 0, Date.now());

            expect(hub.db.doQuery.called).to.be.true;
            // Third doQuery call is the INSERT into reorg_attestations
            let calls = hub.db.doQuery.args;
            let insertCall = calls.find(c => /INSERT INTO reorg_attestations/.test(c[0]));
            expect(insertCall).to.exist;
            expect(insertCall[1][2]).to.equal(0); // reorgHeight
        });

        it('reorg at Number.MAX_SAFE_INTEGER height is accepted', async function () {
            rh.setValidatorSet([]);
            pm.getPeerStatus.returns([]);

            let height = Number.MAX_SAFE_INTEGER;
            await rh.reportReorg('LTC', height, Date.now());

            let calls = hub.db.doQuery.args;
            let insertCall = calls.find(c => /INSERT INTO reorg_attestations/.test(c[0]));
            expect(insertCall).to.exist;
            expect(insertCall[1][2]).to.equal(height);
        });
    });

    // -----------------------------------------------------------------
    // Timestamp boundaries
    // -----------------------------------------------------------------

    describe('timestamp boundaries', function () {

        it('timestamp=0 (unix epoch) is accepted and rollback runs', async function () {
            rh.setValidatorSet([]);
            pm.getPeerStatus.returns([]);

            await rh.reportReorg('BTC', 100, 0);

            let calls = hub.db.doQuery.args;
            let deleteCall = calls.find(c => /DELETE FROM attestations/.test(c[0]));
            expect(deleteCall).to.exist;
            expect(deleteCall[1][1]).to.equal(0); // timestamp param
        });

        it('far-future timestamp is rejected by validation', async function () {
            rh.setValidatorSet([]);
            pm.getPeerStatus.returns([]);

            let futureTs = Date.now() + 1e13; // ~317 years from now
            try {
                await rh.reportReorg('DOGE', 500, futureTs);
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('future');
            }
        });
    });

    // -----------------------------------------------------------------
    // Duplicate detection
    // -----------------------------------------------------------------

    describe('duplicate reorg report', function () {

        it('second call with same reorgId is rate-limited', async function () {
            rh.setValidatorSet([]);
            pm.getPeerStatus.returns([]);

            let ts = Date.now() - 1000;
            await rh.reportReorg('BTC', 200, ts);

            // Second identical report — rate limiter suppresses it
            try {
                await rh.reportReorg('BTC', 200, ts);
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('Rate limit');
            }
        });
    });

    // -----------------------------------------------------------------
    // _getAffectedChains
    // -----------------------------------------------------------------

    describe('_getAffectedChains', function () {

        it("source='BTC' returns ['LTC', 'DOGE']", function () {
            expect(rh._getAffectedChains('BTC')).to.deep.equal(['LTC', 'DOGE']);
        });

        it("source='DOGE' returns ['BTC', 'LTC']", function () {
            expect(rh._getAffectedChains('DOGE')).to.deep.equal(['BTC', 'LTC']);
        });
    });

    // -----------------------------------------------------------------
    // Single-node fallback
    // -----------------------------------------------------------------

    describe('single-node fallback', function () {

        it('stores attestation directly when validatorSet is empty and no peers', async function () {
            rh.setValidatorSet([]);
            pm.getPeerStatus.returns([]);

            let ts = 1700000000000;
            await rh.reportReorg('LTC', 300, ts);

            // Should NOT broadcast — no PBFT needed
            expect(pm.broadcast.called).to.be.false;

            // Should write the reorg attestation
            let insertCall = hub.db.doQuery.args.find(c =>
                /INSERT INTO reorg_attestations/.test(c[0])
            );
            expect(insertCall).to.exist;
            expect(insertCall[1][0]).to.equal('LTC:300:' + ts); // reorgId
            expect(insertCall[1][5]).to.equal(1);               // validatorCount = 1

            // reorgId should be in processed set
            expect(rh.processed.has('LTC:300:' + ts)).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // REORG_ALERT message validation
    // -----------------------------------------------------------------

    describe('REORG_ALERT message validation', function () {

        it('REORG_ALERT with missing fields is ignored', function () {
            rh.setValidatorSet(VALIDATORS_4);

            // Emit a message with a missing reorgId field
            pm.emit('message', {
                type:   'REORG_ALERT',
                sender: makeValidator(2).addr,
                data:   { chain: 'BTC', reorgHeight: 100 /* timestamp and reorgId missing */ }
            });

            // No pending reorg should have been started
            expect(rh.pendingReorgs.size).to.equal(0);
        });
    });
});
