'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon');
const { expect } = require('chai');
const ProviderRegistry = require('../../../../src/validators/provider_registry');
const XChainHub = require('../../../../src/XChainHub');
const { DB_METHODS } = require('../../../helpers/mockHub.js');

function hub(db) {
    return { network: 'mainnet', p2pConfig: { HUB_NETWORK: 'mainnet' },
        db: db || { getConfigRowsByModule: sinon.stub().resolves([]) } };
}

describe('ProviderRegistry block-anchored response cap', function () {
    afterEach(() => sinon.restore());

    it('seeds defaults and resolves cap activations at their block', function () {
        const reg = new ProviderRegistry(hub());
        reg.seedProviderConfigGenesis();
        expect(reg.getMaxResponseBytes('http_get', 10)).to.equal(32768);
        expect(reg.getMaxResponseBytes('llm', 10)).to.equal(16384);
        reg.applyProviderConfigActivation('http_get', 100, {}, null, null, 4096);
        reg.applyProviderConfigActivation('http_get', 200, { other: true });
        expect(reg.getMaxResponseBytes('http_get', 99)).to.equal(32768);
        expect(reg.getMaxResponseBytes('http_get', 100)).to.equal(4096);
        expect(reg.getMaxResponseBytes('http_get', 200)).to.equal(4096);
    });

    it('keeps a live configs-table reload out of historical cap reads', async function () {
        const db = { ...DB_METHODS,
            getConfigRowsByModule: sinon.stub().resolves([{ coin: 'Bitcoin', param_name: 'http_get',
                param_value: JSON.stringify({ provider_id: 'http_get', max_response_bytes: 4096 }) }]),
            doQuery: sinon.stub().resolves([]) };
        const reg = new ProviderRegistry(hub(db));
        await reg.load();
        await reg.loadGovernanceHistory();
        expect(reg.getDef('http_get').max_response_bytes).to.equal(4096);
        expect(reg.getMaxResponseBytes('http_get', 50)).to.equal(32768);
    });

    it('replays the same cap that the live governance path applies', async function () {
        const proposal = { provider_id: 'http_get', max_response_bytes: 4096,
            additional_config: {} };
        const live = new ProviderRegistry(hub());
        live.seedProviderConfigGenesis();
        await XChainHub.prototype.applyProviderGovernanceChange.call({ providerRegistry: live }, {
            parameter: 'ATTESTATION_PROVIDER:http_get', activationBlock: 100,
            newValue: JSON.stringify(proposal)
        });
        const db = { ...DB_METHODS, getConfigRowsByModule: sinon.stub().resolves([]),
            doQuery: sinon.stub().resolves([{ parameter: 'ATTESTATION_PROVIDER:http_get',
                activation_block: 100, proposed_value: JSON.stringify(proposal) }]) };
        const replay = new ProviderRegistry(hub(db));
        await replay.loadGovernanceHistory();
        expect(live.getMaxResponseBytes('http_get', 99)).to.equal(32768);
        expect(live.getMaxResponseBytes('http_get', 100)).to.equal(4096);
        expect(replay.getMaxResponseBytes('http_get', 100)).to.equal(4096);
    });
});
