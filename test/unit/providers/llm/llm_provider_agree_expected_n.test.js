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

// The consensus engine hands agree() only the ok proposals, and passes the responsible-set
// bound as expectedN. A lone ok proposal under an expectedN above one is an unreplicated
// body: it must not be seated as the winner without a judge call.

const { expect } = require('chai');

function reloadProvider() {
    delete require.cache[require.resolve('../../../../src/providers/llm.js')];
    delete require.cache[require.resolve('../../../../src/lib/hub_credentials.js')];
    delete require.cache[require.resolve('../../../../src/providers/llm/claude_spawn.js')];
    return require('../../../../src/providers/llm.js');
}

const APPROVED = 'claude-sonnet-4-6';
const solo = () => [{ body: Buffer.from('only answer'), meta: APPROVED }];

describe('llm provider, agree() lone ok proposal against expectedN', function () {
    it('returns no winner and marks the round inconclusive when more were expected', async function () {
        for (const expectedN of [2, 3, 5]) {
            const llm = reloadProvider();
            const outcome = {};
            const r = await llm.agree(solo(), { expectedN, outcome });
            expect(r, 'expectedN=' + expectedN).to.equal(null);
            expect(outcome.inconclusive).to.equal(true);
            expect(outcome.reason).to.equal('unreplicated_proposal');
        }
    });

    it('still seats a lone proposal when one response was expected', async function () {
        for (const options of [{ expectedN: 1 }, { expectedN: 0 }, {}, undefined]) {
            const llm = reloadProvider();
            const r = await llm.agree(solo(), options);
            expect(r, JSON.stringify(options)).to.not.equal(null);
            expect(r.body.toString()).to.equal('only answer');
            expect(r.meta).to.equal(APPROVED);
        }
    });
});
