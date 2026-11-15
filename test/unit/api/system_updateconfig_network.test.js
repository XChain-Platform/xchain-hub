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
const ConfigParams = require('../../../src/hub/config_params.js');
const { buildSystemRpc } = require('../../../src/api/rpc/system.js');
const bootSettings = require('../../../src/validators/capability_snapshot/boot_settings.js');

function configFor(network, coin) {
    return {
        [coin || 'bitcoin']: {
            [network]: {}
        }
    };
}

function emptyHub() {
    const hub = new ConfigParams();
    hub.network = '';
    return hub;
}

function hubWithBuffer(buffer) {
    const hub = emptyHub();
    hub.capabilitySnapshot = {
        reorgBufferBlocks: buffer,
        assertCanonicalReorgBuffer: bootSettings.assertCanonicalReorgBuffer
    };
    return hub;
}

function restoreSinon() {
    sinon.restore();
    delete process.env.XCHAIN_HUB_SKIP_REORG_BUFFER_ASSERT;
}

function testSharedNetworkAdoption() {
    const hub = emptyHub();
    const config = Object.assign(
        configFor('testnet', 'bitcoin'),
        configFor('testnet', 'dogecoin'),
        configFor('testnet', 'litecoin')
    );

    expect(hub.learnNetworkFromConfig(config)).to.equal('testnet');
    expect(hub.network).to.equal('testnet');
}

function testEveryRecognizedNetwork() {
    for(const network of ['mainnet', 'testnet', 'regtest']){
        const hub = emptyHub();
        hub.learnNetworkFromConfig(configFor(network));
        expect(hub.network).to.equal(network);
    }
}

function testNonObjectMetadata() {
    const hub = emptyHub();
    const config = configFor('regtest');
    config.bitcoin.label = 'local development';
    config.bitcoin.disabled = false;
    config.bitcoin.optional = null;

    hub.learnNetworkFromConfig(config);
    expect(hub.network).to.equal('regtest');
}

function testEmptyOrNonObjectConfig() {
    for(const config of [{}, null, [], 'regtest']){
        const hub = emptyHub();
        hub.learnNetworkFromConfig(config);
        expect(hub.network).to.equal('');
    }
}

function testUnknownNetworkRefusal() {
    const hub = emptyHub();
    hub.learnNetworkFromConfig(configFor('signet'));
    expect(hub.network).to.equal('');
}

function testRecognizedAndUnknownRefusal() {
    const hub = emptyHub();
    const config = Object.assign(
        configFor('mainnet', 'bitcoin'),
        configFor('production', 'dogecoin')
    );

    hub.learnNetworkFromConfig(config);
    expect(hub.network).to.equal('');
}

function testMixedNetworkRefusal() {
    const hub = emptyHub();
    const config = Object.assign(
        configFor('mainnet', 'bitcoin'),
        configFor('testnet', 'dogecoin')
    );

    hub.learnNetworkFromConfig(config);
    expect(hub.network).to.equal('');
}

function testConfiguredNetworkPreservation() {
    const hub = emptyHub();
    hub.network = 'mainnet';

    expect(hub.learnNetworkFromConfig(configFor('regtest'))).to.equal('mainnet');
    expect(hub.network).to.equal('mainnet');
}

function testNonCanonicalBufferRefusal() {
    for(const network of ['mainnet', 'testnet', 'regtest']){
        const hub = hubWithBuffer(0);
        let thrown = null;
        try { hub.learnNetworkFromConfig(configFor(network)); } catch (err) { thrown = err; }
        expect(thrown).to.be.an('error');
        expect(thrown.code).to.equal('REORG_BUFFER_MISMATCH');
        expect(hub.network).to.equal('');
    }
}

function testCanonicalBufferAdoption() {
    const hub = hubWithBuffer(6);
    expect(hub.learnNetworkFromConfig(configFor('mainnet'))).to.equal('mainnet');
}

function testRetiredBypassRefusal() {
    const hub = hubWithBuffer(0);
    process.env.XCHAIN_HUB_SKIP_REORG_BUFFER_ASSERT = '1';
    expect(() => hub.learnNetworkFromConfig(configFor('mainnet')))
        .to.throw().with.property('code', 'REORG_BUFFER_MISMATCH');
    expect(hub.network).to.equal('');
}

async function testUpdateConfigRefusalIsAtomic() {
    const hub = hubWithBuffer(0);
    hub.addParametersFromJson = sinon.stub().resolves(true);
    const result = await buildSystemRpc({ hub }).updateconfig({ config: configFor('mainnet') });
    expect(result.error).to.match(/HUB_SNAPSHOT_REORG_BUFFER/);
    expect(hub.network).to.equal('');
    expect(hub.addParametersFromJson.called).to.equal(false);
}

async function testLearnBeforeProposal() {
    const hub = emptyHub();
    hub.consensus = {
        propose: sinon.stub().callsFake(async function assertLearnedNetwork() {
            expect(hub.network).to.equal('regtest');
        })
    };
    const learn = sinon.spy(hub, 'learnNetworkFromConfig');
    const add = sinon.spy(hub, 'addParametersFromJson');
    const config = configFor('regtest');

    expect(await buildSystemRpc({ hub }).updateconfig({ config }))
        .to.deep.equal({ status: 'success' });
    expect(learn.calledOnceWithExactly(config)).to.equal(true);
    expect(add.calledOnceWithExactly(config)).to.equal(true);
    expect(learn.calledBefore(add)).to.equal(true);
    expect(hub.consensus.propose.calledOnceWithExactly(config)).to.equal(true);
}

function registerNetworkLearningTests() {
    afterEach(restoreSinon);
    it('adopts a recognized network shared by every coin', testSharedNetworkAdoption);
    it('can adopt each recognized network', testEveryRecognizedNetwork);
    it('ignores non-object metadata when object slots agree', testNonObjectMetadata);
    it('leaves the network empty for empty or non-object config', testEmptyOrNonObjectConfig);
    it('refuses an unknown object-valued network key', testUnknownNetworkRefusal);
    it('refuses a recognized network paired with an unknown network', testRecognizedAndUnknownRefusal);
    it('refuses mixed recognized networks', testMixedNetworkRefusal);
    it('preserves an already configured network', testConfiguredNetworkPreservation);
    it('refuses every learned consensus network with a non-canonical buffer', testNonCanonicalBufferRefusal);
    it('adopts a learned network with the canonical buffer', testCanonicalBufferAdoption);
    it('does not let the retired bypass weaken learned-network checks', testRetiredBypassRefusal);
    it('leaves updateconfig unapplied when learned-network validation fails', testUpdateConfigRefusalIsAtomic);
    it('learns the network before proposing the config', testLearnBeforeProposal);
}

describe('system updateconfig network learning', registerNetworkLearningTests);
