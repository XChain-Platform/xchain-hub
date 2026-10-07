'use strict';

const { expect } = require('chai');
const Governance = require('../../../../src/validators/governance');
const rules = require('../../../../src/validators/governance/rules.js');
const { createMockHub } = require('../../../helpers/mockHub');

describe('governance tally failover gate', function () {
    let hub, gov;
    beforeEach(function () {
        hub = createMockHub();
        gov = new Governance(hub);
    });

    it('exposes the request type and takeover step constants', function () {
        expect(rules.GOV_RESULT_REQ).to.equal('GOV_RESULT_REQ');
        expect(rules.GOV_TAKEOVER_STEP_BLOCKS).to.be.a('number');
        expect(Number.isInteger(rules.GOV_TAKEOVER_STEP_BLOCKS)).to.equal(true);
        expect(rules.GOV_TAKEOVER_STEP_BLOCKS).to.be.greaterThan(0);
    });

    it('arms regtest at 0 and leaves testnet and mainnet unpinned', function () {
        const t = rules.GOV_TALLY_FAILOVER_ACTIVATION;
        expect(t.regtest).to.equal(0);
        expect(t.testnet).to.equal(null);
        expect(t.mainnet).to.equal(null);
    });

    it('isTallyFailoverActive is on for regtest with an observed tip', function () {
        hub.network = 'regtest';
        hub._latestBlockIndex = 0;
        expect(gov.isTallyFailoverActive()).to.equal(true);
    });

    it('isTallyFailoverActive is off with no tip, no network, or an unpinned network', function () {
        expect(gov.isTallyFailoverActive(), 'no network').to.equal(false);
        hub.network = 'regtest';
        hub._latestBlockIndex = null;
        expect(gov.isTallyFailoverActive(), 'no tip').to.equal(false);
        for (const net of ['testnet', 'mainnet']) {
            hub.network = net;
            hub._latestBlockIndex = 99999999;
            expect(gov.isTallyFailoverActive(), net).to.equal(false);
        }
    });
});
