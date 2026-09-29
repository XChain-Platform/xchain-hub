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
// CONSENSUS GUARD: a configured hub and a config-free hub must resolve the same
// MIN_STAKE for the same (capability, block), before and after a governance
// activation, or they qualify different validator sets for one round. This is
// a precondition for lifting MIN_STAKE_GOVERNANCE_DISABLED.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const minStake   = require('../../../src/validators/capability_snapshot/min_stake.js');

// The canonical floor the stake-weight feed reports, which boot requires every
// configured hub's genesis MIN_STAKE to equal.
const FLOOR      = '1000.00000000';
const RAISED     = '25000.00000000';
const ACTIVATION = 5000;

function loadRegistry() {
    let stubs = {};
    for (let cap of ['price', 'cross_chain', 'oracle_publish', 'attestation', 'full_node'])
        stubs[cap] = { selfTest: sinon.stub().resolves({ ok: true, reason: null }) };
    return proxyquire('../../../src/validators/capability_registry', { '../capabilities/index.js': stubs });
}

// A snapshot-shaped reader over one hub's registry and stake-weight feed.
function hubReader(CapabilityRegistry, capabilities) {
    let hub = { db: {}, p2pConfig: capabilities ? { CAPABILITIES: capabilities } : {} };
    hub.capabilityRegistry = new CapabilityRegistry(hub);
    hub.stakeWeightFeed    = { minStake: () => FLOOR };
    let reader = Object.assign({ hub }, minStake, { noteFeedFloor() {} });
    return {
        registry: hub.capabilityRegistry,
        resolve:  (block) => reader.resolveMinStake('price', block)
    };
}

function registerRegistryTests() {
    it('answers null below a config-free hub\'s first activation, then the activated value', function () {
        let CapabilityRegistry = loadRegistry();
        let r = new CapabilityRegistry({ db: {}, p2pConfig: {} });
        r.applyMinStakeActivation('price', ACTIVATION, RAISED);
        expect(r.getMinStake('price', ACTIVATION - 1)).to.equal(null);
        expect(r.getMinStake('price', ACTIVATION)).to.equal(RAISED);
        expect(r.getMinStake('price', 9999)).to.equal(RAISED);
        expect(r.getMinStake('price')).to.equal(RAISED);
    });

    it('keeps a configured hub on its genesis value below the activation', function () {
        let CapabilityRegistry = loadRegistry();
        let r = new CapabilityRegistry({ db: {}, p2pConfig: { CAPABILITIES: { price: { MIN_STAKE: FLOOR } } } });
        r.applyMinStakeActivation('price', ACTIVATION, RAISED);
        expect(r.getMinStake('price', 0)).to.equal(FLOOR);
        expect(r.getMinStake('price', ACTIVATION - 1)).to.equal(FLOOR);
        expect(r.getMinStake('price', ACTIVATION)).to.equal(RAISED);
    });
}

function registerParityTests() {
    it('resolves the same threshold on configured and config-free hubs at every height', function () {
        let CapabilityRegistry = loadRegistry();
        let configured = hubReader(CapabilityRegistry, { price: { MIN_STAKE: FLOOR } });
        let configFree = hubReader(CapabilityRegistry, null);
        for (let b of [0, ACTIVATION - 1]) expect(configFree.resolve(b)).to.equal(configured.resolve(b));

        configured.registry.applyMinStakeActivation('price', ACTIVATION, RAISED);
        configFree.registry.applyMinStakeActivation('price', ACTIVATION, RAISED);
        let heights = [0, ACTIVATION - 1, ACTIVATION, 9999];
        expect(heights.map(configFree.resolve)).to.deep.equal(heights.map(configured.resolve));
        expect(heights.map(configFree.resolve)).to.deep.equal([FLOOR, FLOOR, RAISED, RAISED]);
    });
}

describe('MIN_STAKE resolution: configured and config-free hubs agree per block', function () {
    describe('CapabilityRegistry.getMinStake before the first entry', registerRegistryTests);
    describe('CapabilitySnapshot.resolveMinStake parity', registerParityTests);
});
