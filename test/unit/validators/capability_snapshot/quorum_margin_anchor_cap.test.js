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

const sinon = require('sinon');
const { expect } = require('chai');
const { buildOracleRpc } = require('../../../../src/api/rpc/oracle.js');

function row(anchor) {
    return {
        round_number: anchor,
        coin_pair: 'BTC/USD',
        status: 'finalized',
        reference_block: anchor,
        consensus_proof: JSON.stringify([
            { pubkey: 'a', sig: 'sig-a' },
            { pubkey: 'b', sig: 'sig-b' },
            { pubkey: 'c', sig: 'sig-c' },
        ]),
    };
}

function fixture(rows) {
    const getSnapshot = sinon.stub().resolves({
        validators: ['a', 'b', 'c', 'd'].map(pubkey => ({ pubkey })),
    });
    const hub = {
        network: 'mainnet',
        capabilitySnapshot: { getSnapshot },
        getPriceSnapshots: sinon.stub().resolves(rows),
    };
    return { getSnapshot, rpc: buildOracleRpc({ hub }) };
}

describe('getpricesnapshots quorum margin anchor budget', function () {
    afterEach(function () { sinon.restore(); });

    it('reads only the first 16 distinct anchors and nulls every row for an excess anchor', async function () {
        const accepted = Array.from({ length: 16 }, (_, index) => row(100 + index));
        const excess = row(116);
        const rows = accepted.concat([excess, row(100), row(116)]);
        const { getSnapshot, rpc } = fixture(rows);

        const out = await rpc.getpricesnapshots({ with_quorum_margin: true });

        expect(getSnapshot.callCount).to.equal(16);
        expect(out.slice(0, 16).every(item => item.quorum_margin !== null)).to.equal(true);
        expect(out[16].quorum_margin).to.equal(null);
        expect(out[17].quorum_margin).to.deep.equal(out[0].quorum_margin);
        expect(out[18].quorum_margin).to.equal(null);
    });
});
