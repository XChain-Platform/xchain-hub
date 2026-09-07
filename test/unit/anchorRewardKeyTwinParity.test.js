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
 * anchorRewardKeyTwinParity: the reward-ledger round qualifier is written twice, once
 * in xchain-indexer/src/anchor_reward_key.js and once in the hub's vendored copy. The
 * qualifier decides whether two archive rewards are the SAME ledger row, so a drift lets
 * the hub conserve a reward the indexer pays, or refuse to co-sign an archive the indexer
 * derives. The rule drifted once already as prose (the hub carried the blocker text while
 * its own key stayed four columns), which is why the copies are now byte-checked.
 *
 * Only the executable region is compared: each header names its OWN call sites, the same
 * convention checkpoint_commitment_activation's cross-service parity suite uses. The
 * indexer twin is resolved by monorepo-relative path; a standalone hub checkout skips the
 * byte comparison (unless XCHAIN_REQUIRE_SIBLINGS=1) and still exercises the rule itself.
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const HUB_COPY     = path.join(__dirname, '../../src/anchor_reward_key.js');
const INDEXER_COPY = path.join(__dirname, '../../../xchain-indexer/src/anchor_reward_key.js');

// Everything from the strict-mode pragma down: the constant, both forms of the rule and
// the exports. The license/purpose header above it is per-repo by construction.
function codeOnly(source){
    const at = source.indexOf("'use strict';");
    assert.notStrictEqual(at, -1, 'expected a strict-mode pragma to slice the header at');
    return source.slice(at);
}

describe('anchor_reward_key twin parity (hub <-> indexer) @regression', function () {
    const ark = require('../../src/anchor_reward_key.js');

    it('the executable region is byte-identical to the indexer copy', function () {
        if(!fs.existsSync(INDEXER_COPY)){
            if(process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the indexer twin is absent at ' + INDEXER_COPY);
            this.skip();
            return;
        }
        assert.strictEqual(
            codeOnly(fs.readFileSync(HUB_COPY, 'utf8')),
            codeOnly(fs.readFileSync(INDEXER_COPY, 'utf8')),
            'xchain-hub/src/anchor_reward_key.js drifted from the indexer copy');
    });

    it('qualifies the archive leg by its snapshot block and every other type to 0', function () {
        assert.strictEqual(ark.ARCHIVE_REWARD_TYPE, 'anchor_archive');
        assert.strictEqual(ark.rewardRoundQualifier('anchor_archive', 912345), 912345);
        assert.strictEqual(ark.rewardRoundQualifier('anchor_archive', '912345'), 912345);
        for(const type of ['anchor_BTC', 'anchor_LTC', 'anchor_DOGE', 'anchor_bundle', 'oracle_round', 'attest_fee'])
            assert.strictEqual(ark.rewardRoundQualifier(type, 912345), 0,
                type + ' must keep the key it had before the column existed');
    });

    it('floors an archive qualifier to the legacy 0 rather than writing a non-finite key', function () {
        assert.strictEqual(ark.rewardRoundQualifier('anchor_archive', undefined), 0);
        assert.strictEqual(ark.rewardRoundQualifier('anchor_archive', 'not-a-height'), 0);
        assert.strictEqual(ark.rewardRoundQualifier('anchor_archive', -5), 0);
    });
});
