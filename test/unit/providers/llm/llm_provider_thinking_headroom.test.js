/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - llm provider tests: always-thinking model fetch headroom
 *
 * A model that thinks on every call spends thinking tokens out of max_tokens,
 * so a fetch sized to the content bound alone can return no text block.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const nock = require('nock');
const models = require('../../../../src/providers/llm/models');

function reloadProvider() {
    delete require.cache[require.resolve('../../../../src/providers/llm.js')];
    delete require.cache[require.resolve('../../../../src/lib/hub_credentials.js')];
    delete require.cache[require.resolve('../../../../src/providers/llm/claude_spawn.js')];
    return require('../../../../src/providers/llm.js');
}

const THINKING_FLOOR = 2048;

describe('llm provider, always-thinking fetch headroom', function () {
    this.timeout(20000);

    let savedKey;
    beforeEach(function () { savedKey = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'sk-ant-test'; });
    afterEach(function () {
        nock.cleanAll();
        if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
    });

    it('grants headroom to the always-thinking ids, bare and dated', function () {
        for (const id of ['claude-opus-4-7', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-7-20260101'])
            expect(models.needsFetchReasoningHeadroom(id), id).to.equal(true);
    });

    it('keeps the OpenAI reasoning family and leaves non-thinking ids unchanged', function () {
        expect(models.needsFetchReasoningHeadroom('gpt-5-mini')).to.equal(true);
        for (const id of ['claude-sonnet-4-6', 'claude-haiku-4-5', 'gpt-4o', 'gpt-5-chat-latest'])
            expect(models.needsFetchReasoningHeadroom(id), id).to.equal(false);
    });

    it('does not widen the OpenAI-only reasoning predicate', function () {
        expect(models.isReasoningModel('claude-opus-4-7')).to.equal(false);
    });

    it('returns a non-empty text block for a thinking model id', async function () {
        const llm = reloadProvider();
        let sent;
        nock(/^https:\/\/api\.[a-z]+\.com$/)
            .post('/v1/messages', (body) => { sent = body.max_tokens; return true; })
            .reply(200, () => ({
                content: sent > THINKING_FLOOR
                    ? [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'answer' }]
                    : [{ type: 'thinking', thinking: 'x' }],
                usage: { input_tokens: 1, output_tokens: 1 }
            }));
        const out = await llm.fetch(JSON.stringify({ prompt: 'q', max_tokens: 64 }), { pinnedModel: 'claude-opus-4-7' });
        expect(sent).to.be.greaterThan(THINKING_FLOOR);
        expect(Buffer.from(out.body).toString('utf8')).to.equal('answer');
    });
});
