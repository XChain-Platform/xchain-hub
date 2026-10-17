// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// RetractionConsensus snapshot block: the sibling engines take a regtest snapshot-block
// override, retraction takes none, so a stray override field or the DEX env knob never
// stands in for a missing BTC tip.

const assert = require('assert');
const RetractionConsensus = require('../../../../src/consensus/retraction.js');

function makeConsensus(btcBlock, p2p){
    return new RetractionConsensus({ db: {}, network: 'regtest', p2pConfig: p2p || {},
        resolveBtcLatestBlock: async () => btcBlock });
}

describe('RetractionConsensus snapshot block is the BTC tip only', function () {
    let saved;
    beforeEach(function () { saved = process.env.XDEX_SNAPSHOT_BLOCK; process.env.XDEX_SNAPSHOT_BLOCK = '42'; });
    afterEach(function () {
        if (saved === undefined) delete process.env.XDEX_SNAPSHOT_BLOCK;
        else process.env.XDEX_SNAPSHOT_BLOCK = saved;
    });

    it('returns null with no BTC tip on regtest even with an override field and the DEX knob set', async function () {
        let c = makeConsensus(null, { XDEX_SNAPSHOT_BLOCK: 42 });
        c._snapshotBlockOverride = 42;
        assert.strictEqual(await c.resolveSnapshotBlock(), null);
    });

    it('returns the BTC tip when there is one', async function () {
        assert.strictEqual(await makeConsensus(5000).resolveSnapshotBlock(), 5000);
    });
});
