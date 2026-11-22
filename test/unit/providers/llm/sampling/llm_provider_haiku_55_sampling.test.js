'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const models = require('../../../../../src/providers/llm/models');
const { judgeRequest } = require('../../../../../src/providers/llm/judge');
const { anthropicRequestBody } = require('../../../../../src/providers/llm/transports');

describe('llm provider Haiku 5.5 sampling contract', function () {
    it('classifies the exact id and dated snapshots without matching near misses', function () {
        expect(models.anthropicRejectsSampling('claude-haiku-5-5')).to.equal(true);
        expect(models.anthropicRejectsSampling('claude-haiku-5-5-20261007')).to.equal(true);
        expect(models.anthropicRejectsSampling('claude-haiku-5-50')).to.equal(false);
        expect(models.anthropicRejectsSampling('claude-haiku-4-5')).to.equal(false);
    });

    it('omits temperature and grants reasoning budget on fetch and judge shapes', function () {
        const fetch = anthropicRequestBody('claude-haiku-5-5', 4096, 0, 'prompt', 'system');
        expect(fetch).to.not.have.property('temperature');
        const judge = judgeRequest('claude-haiku-5-5', 'system', 'prompt', 1000, {});
        expect(judge.maxTokens).to.equal(models.JUDGE_MAX_TOKENS_REASONING);
        const judgeBody = anthropicRequestBody(judge.model, judge.maxTokens,
            judge.temperature, judge.prompt, judge.system);
        expect(judgeBody).to.not.have.property('temperature');
    });
});
