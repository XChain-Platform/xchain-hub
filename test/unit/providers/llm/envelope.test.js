/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const {
    parseEnvelope,
    resolveFetchModel,
    responseBody
} = require('../../../../src/providers/llm/envelope');

const settings = {
    PROMPT_ENVELOPE_VERSION: 1,
    APPROVED_MODELS: ['primary-model', 'backup-model']
};

function expectLlmError(fn) {
    expect(fn).to.throw(/^llm:/);
}

function parse(value, options = { modelRank: 0 }) {
    return parseEnvelope(settings, JSON.stringify(value), options);
}

describe('llm envelope boundary helpers', function () {
    registerParseEnvelopeTests();
    registerResolveFetchModelTests();
    registerResponseBodyTests();
});

function registerParseEnvelopeTests() {
    describe('parseEnvelope', function () {
        it('rejects non-JSON payloads', function () {
            expectLlmError(() => parseEnvelope(settings, '{', { modelRank: 0 }));
        });

        it('rejects a missing or non-string prompt', function () {
            for (const envelope of [{}, { prompt: 42 }])
                expectLlmError(() => parse(envelope));
        });

        it('rejects an unsupported envelope version', function () {
            expectLlmError(() => parse({ prompt: 'hello', envelope_version: 2 }));
        });

        it('rejects max_tokens values that are not positive integers', function () {
            for (const maxTokens of [0, -1, 1.5, 'invalid'])
                expectLlmError(() => parse({ prompt: 'hello', max_tokens: maxTokens }));
        });

        it('rejects temperatures outside the range or of the wrong type', function () {
            for (const temperature of [-0.1, 2.1, '1', null])
                expectLlmError(() => parse({ prompt: 'hello', temperature }));
        });

        it('rejects a non-string system prompt', function () {
            for (const system of [42, { role: 'system' }])
                expectLlmError(() => parse({ prompt: 'hello', system }));
        });

        it('rejects fallback values other than any or strict', function () {
            expectLlmError(() => parse({ prompt: 'hello', fallback: 'best' }));
        });

        it('rejects strict fallback after the primary model', function () {
            expectLlmError(() => parse({ prompt: 'hello', fallback: 'strict' }, { modelRank: 1 }));
        });

        it('returns a valid parsed envelope', function () {
            const envelope = {
                prompt: 'hello',
                envelope_version: 1,
                max_tokens: 128,
                temperature: 0.5,
                system: 'be concise',
                fallback: 'strict'
            };
            expect(parse(envelope)).to.deep.equal(envelope);
        });
    });
}

function registerResolveFetchModelTests() {
    describe('resolveFetchModel', function () {
        it('returns the pinned model when provided', function () {
            expect(resolveFetchModel(settings, { pinnedModel: 'pinned-model' }))
                .to.equal('pinned-model');
        });

        it('returns the first approved model without a pin', function () {
            expect(resolveFetchModel(settings, {})).to.equal('primary-model');
        });
    });
}

function registerResponseBodyTests() {
    describe('responseBody', function () {
        it('rejects empty text', function () {
            expectLlmError(() => responseBody('', {}, 'primary-model'));
        });

        it('rejects a body over a non-zero byte cap', function () {
            expectLlmError(() => responseBody('é', { maxResponseBytes: 1 }, 'primary-model'));
        });

        it('returns the buffered body and model metadata otherwise', function () {
            const result = responseBody('answer', { maxResponseBytes: 0 }, 'primary-model');
            expect(result).to.deep.equal({
                body: Buffer.from('answer', 'utf8'),
                meta: 'primary-model'
            });
        });
    });
}
