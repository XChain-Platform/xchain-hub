/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************/

'use strict';

const { expect } = require('chai');
const providerPins = require('../../../../../src/attestation/round/provider_pins.js');

function pinWith(config) {
    const round = {
        providerRegistry: { getAdditionalConfig: () => config },
        confirmationsFor: () => 1
    };
    return providerPins.pinModels.call(round, 'llm', 100, 0, {});
}

describe('AttestationRound block-anchored vendor pins', function () {

    it('distinguishes an empty anchored map from no anchored config', function () {
        const explicit = pinWith({
            approved_models: ['llama-3-70b'],
            model_vendors: { 'llama-3-70b': 'openai' },
            max_completion_tokens: 2048,
            default_temperature: 0.25,
            prompt_envelope_version: 2
        });
        const empty = pinWith({ approved_models: ['claude-sonnet-4-6'] });
        const absent = pinWith(null);
        expect(explicit.pinnedVendors).to.deep.equal({ 'llama-3-70b': 'openai' });
        expect(empty.pinnedVendors).to.deep.equal({});
        expect(absent.pinnedVendors).to.equal(null);
        expect(explicit.pinnedRequestBounds).to.deep.equal({
            max_completion_tokens: 2048,
            default_temperature: 0.25,
            prompt_envelope_version: 2
        });
        expect(empty.pinnedRequestBounds).to.deep.equal({
            max_completion_tokens: undefined,
            default_temperature: undefined,
            prompt_envelope_version: undefined
        });
        expect(absent.pinnedRequestBounds).to.equal(null);
    });

    it('treats a malformed anchored map as empty and exclusive', function () {
        expect(pinWith({ model_vendors: ['openai'] }).pinnedVendors).to.deep.equal({});
    });
});
