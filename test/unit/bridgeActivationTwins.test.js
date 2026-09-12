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

    // Row 28: the bridge twin is keyed '<COIN>:<network>' because the three chains reach the
    // flag day at three heights. The engine calls the predicate with a third argument, so a
    // twin whose predicate still took two would silently read the bare network key for every
    // chain and open the bridge on LTC and DOGE the moment BTC crossed. Byte-equality to the
    // indexer (above) does not catch that on its own: it would only prove the hub is running
    // whatever the indexer runs, including the wrong arity. This drives the hub's own copy.
    it('the hub copy of the bridge twin resolves a coin-keyed slot ahead of the bare network key', function () {
        const { XCHAIN_BRIDGE_ACTIVATION, isXchainBridgeActive } = require('../../src/xchain_bridge_activation.js');
        const saved = XCHAIN_BRIDGE_ACTIVATION['LTC:regtest'];
        XCHAIN_BRIDGE_ACTIVATION['LTC:regtest'] = 700;
        try {
            assert.strictEqual(isXchainBridgeActive(100, 'regtest', 'LTC'), false, 'LTC below its own slot');
            assert.strictEqual(isXchainBridgeActive(700, 'regtest', 'LTC'), true,  'LTC at its own slot');
            assert.strictEqual(isXchainBridgeActive(100, 'regtest', 'BTC'), true,  'BTC keeps the bare regtest 0');
            assert.strictEqual(isXchainBridgeActive(100, 'regtest'), true,         'no coin falls back to the bare key');
        } finally {
            if (saved === undefined) delete XCHAIN_BRIDGE_ACTIVATION['LTC:regtest'];
            else XCHAIN_BRIDGE_ACTIVATION['LTC:regtest'] = saved;
        }
        assert.strictEqual(XCHAIN_BRIDGE_ACTIVATION['LTC:regtest'], saved, 'the vendored map was not restored');
    });

    // The hub's three shipped maps must stay dark on both live networks for every chain: the
    // hub signs transfer records, so an armed slot here is a federation that starts signing
    // on a network the fleet has not deployed the flag day to.
    it('holds every mainnet and testnet slot of all three twins unarmed', function () {
        const maps = {
            XCHAIN_BRIDGE_ACTIVATION: require('../../src/xchain_bridge_activation.js').XCHAIN_BRIDGE_ACTIVATION,
            TOKEN_BRIDGE_ACTIVATION:  require('../../src/token_bridge_activation.js').TOKEN_BRIDGE_ACTIVATION,
            TOKEN_POLICY_INHERITANCE_ACTIVATION:
                require('../../src/token_policy_activation.js').TOKEN_POLICY_INHERITANCE_ACTIVATION
        };
        for (const [name, map] of Object.entries(maps)) {
            let checked = 0;
            for (const key of Object.keys(map)) {
                if (!/mainnet|testnet/.test(key)) continue;
                checked++;
                assert.strictEqual(map[key], 9999999999,
                    name + '.' + key + ' is off the house sentinel; arming a live network is the operator\'s ' +
                    'act on the arming train, never a code change');
            }
            assert.ok(checked >= 2, 'not vacuous: ' + name + ' declares no live-network slot');
        }
    });
});
