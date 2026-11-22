/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
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
const JudgeAgreement = require('../../../../../src/providers/llm/agree.js');

describe('llm judge served-model mismatch', function () {
    it('advances to the next judge because the pinned model produced no verdict', async function () {
        const calls = [];
        const judge = buildJudge(calls);
        const proposals = [
            { body: Buffer.from('answer A'), meta: 'claude-sonnet-4-6' },
            { body: Buffer.from('answer A.'), meta: 'claude-sonnet-4-6' }
        ];

        const winner = await judge.agree(proposals, { pinnedJudgeModel: 'claude-haiku-4-5' });

        expect(winner).to.exist;
        expect(calls).to.deep.equal(['claude-haiku-4-5', 'gpt-5-mini']);
    });
});

function buildJudge(calls) {
    const judge = new JudgeAgreement({
        logger: { warn() {} },
        settings: {
            JUDGE_FALLBACK_MODELS: ['gpt-5-mini'],
            llmEnabled: () => true
        },
        spend: {
            spendGuard: () => ({ allow: () => true }),
            runLlm: async () => null
        },
        metaGates: { canonicalMeta: (proposals, index) => proposals[index].meta }
    });
    judge.setJudgeCallForTest(async (opts) => {
        calls.push(opts.model);
        if (calls.length === 1) {
            let err = new Error('served by another model');
            err.kind = 'model_mismatch';
            err.transient = false;
            err.servedModels = ['claude-opus-5-5'];
            throw err;
        }
        return '{"equivalent": true, "canonical_index": 1}';
    });
    return judge;
}
