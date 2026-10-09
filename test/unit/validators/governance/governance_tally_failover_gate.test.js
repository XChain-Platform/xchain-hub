'use strict';

const { expect } = require('chai');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Governance = require('../../../../src/validators/governance');
const rules = require('../../../../src/validators/governance/rules.js');
const { createMockHub } = require('../../../helpers/mockHub');

const PINS = path.resolve(__dirname, '../../../../bin/pins');

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

    it('pins the hub-only governance rows outside the shared carrier digest', function () {
        const identity = JSON.parse(fs.readFileSync(path.join(PINS, 'at1-consensus-identity.json'), 'utf8'));
        const carrier = JSON.parse(fs.readFileSync(path.join(PINS, 'carrier-logic.json'), 'utf8'));
        const gates = identity.hub_only_rules_gates;
        const expected = {
            'validators/governance/rules.GOV_SNAPSHOT_ACTIVATION': '{"mainnet":963000,"regtest":0,"testnet":0}',
            'validators/governance/rules.GOV_TALLY_FAILOVER_ACTIVATION': '{"mainnet":null,"regtest":0,"testnet":null}',
        };
        const preimage = Object.keys(gates).sort().map((key) => `${key}=${gates[key]}`).join('\n');

        expect(gates).to.include(expected);
        expect(identity.hub_only_gate_key_count).to.equal(Object.keys(gates).length);
        expect(identity.hub_only_rules_digest).to.equal(crypto.createHash('sha256').update(preimage).digest('hex'));
        expect(carrier.entries.consensus_rules_digest.note)
            .to.equal('Hub-only registry values are pinned separately by at1-consensus-identity.json.');
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
