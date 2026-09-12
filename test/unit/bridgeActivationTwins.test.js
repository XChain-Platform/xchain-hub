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
 * bridgeActivationTwins: xchain-hub's CrossChainBridgeEngine gates the bridge, token
 * bridge and token policy inheritance families on three activation modules it vendors
 * from xchain-indexer, the same way it already vendors checkpoint_commitment_activation
 * (the twin reconciliation script). A hand-edited hub copy that drifts from the indexer
 * canonical would let the hub arm a flag day on a different height than the indexer, so
 * every hub copy is pinned byte-identical here rather than trusted to stay in sync.
 *
 * Unlike anchor_reward_key's twin test, these three files are pure copies (no per-repo
 * header, since the hub copy IS the indexer file with 'cp'), so the whole file is
 * compared rather than slicing off a license header.
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const TWINS = [
    'xchain_bridge_activation.js',
    'token_bridge_activation.js',
    'token_policy_activation.js'
];

describe('bridge/token/policy activation twin parity (hub <-> indexer) @regression', function () {
    for (const name of TWINS) {
        const hubCopy     = path.join(__dirname, '../../src/' + name);
        const indexerCopy = path.join(__dirname, '../../../xchain-indexer/src/' + name);

        it(name + ' is byte-identical to the indexer canonical', function () {
            if (!fs.existsSync(indexerCopy)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the indexer twin is absent at ' + indexerCopy);
                this.skip();
                return;
            }
            assert.ok(fs.existsSync(hubCopy), 'xchain-hub/src/' + name + ' has not been vendored');
            assert.strictEqual(
                fs.readFileSync(hubCopy, 'utf8'),
                fs.readFileSync(indexerCopy, 'utf8'),
                'xchain-hub/src/' + name + ' drifted from the indexer canonical');
        });
    }

    it('the hub can require each twin and resolve its activation predicate', function () {
        const bridge = require('../../src/xchain_bridge_activation.js');
        const token  = require('../../src/token_bridge_activation.js');
        const policy = require('../../src/token_policy_activation.js');
        assert.strictEqual(typeof bridge.isXchainBridgeActive, 'function');
        assert.strictEqual(typeof token.isTokenBridgeActive, 'function');
        assert.strictEqual(typeof policy.isTokenPolicyInheritanceActive, 'function');
    });
});
