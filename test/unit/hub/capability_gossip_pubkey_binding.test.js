'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const sinon = require('sinon');
const CapabilityGossip = require('../../../src/hub/capability_gossip.js');
const { getLogger } = require('../../../src/observability');

const ATTACKER = '02' + 'aa'.repeat(32);
const VICTIM = '03' + 'bb'.repeat(32);
const CAPABILITY = 'oracle_publish';

function makeHub(registered){
    const hub = new CapabilityGossip();
    hub.calls = [];
    hub.peerManager = { validatorPubkeys: new Map(registered || []) };
    hub.capabilityRegistry = {
        setSelfTestResult: async (...args) => hub.calls.push(['self', ...args]),
        setQualification: async (...args) => hub.calls.push(['qualification', ...args]),
        setEnabled: async (...args) => hub.calls.push(['enabled', ...args])
    };
    return hub;
}

function message(type, sigPubkey, claimedPubkey){
    return {
        type, sender: 'unknown-peer', sig_pubkey: sigPubkey,
        data: { pubkey: claimedPubkey, capability: CAPABILITY, ok: true }
    };
}

describe('capability gossip proven pubkey binding', function () {
    let warns;
    beforeEach(function () {
        warns = [];
        sinon.stub(getLogger(), 'warn').callsFake(value => warns.push(String(value)));
    });
    afterEach(function () { sinon.restore(); });

    for(const type of ['CAPABILITY_DEACTIVATED', 'CAPABILITY_SELF_TEST', 'CAPABILITY_ACTIVATED']){
        it('drops an unregistered sender forging ' + type, async function () {
            const hub = makeHub();
            await hub.handleCapabilityMessage(message(type, ATTACKER, VICTIM));
            expect(hub.calls).to.deep.equal([]);
            expect(warns.some(value => value.includes('proven signing key'))).to.equal(true);
        });
    }

    it('drops an envelope without a proven key', async function () {
        const hub = makeHub();
        await hub.handleCapabilityMessage(message('CAPABILITY_DEACTIVATED', undefined, VICTIM));
        expect(hub.calls).to.deep.equal([]);
    });

    it('accepts case differences for an honest unregistered signer', async function () {
        const hub = makeHub();
        await hub.handleCapabilityMessage(message('CAPABILITY_DEACTIVATED', VICTIM.toUpperCase(), VICTIM));
        expect(hub.calls).to.have.length(1);
        expect(hub.calls[0].slice(0, 4)).to.deep.equal(['self', VICTIM, CAPABILITY, false]);
    });

    it('keeps the address registry binding as an additional check', async function () {
        const hub = makeHub([['unknown-peer', ATTACKER]]);
        await hub.handleCapabilityMessage(message('CAPABILITY_DEACTIVATED', VICTIM, VICTIM));
        expect(hub.calls).to.deep.equal([]);
        expect(warns.some(value => value.includes('registered as'))).to.equal(true);
    });
});
