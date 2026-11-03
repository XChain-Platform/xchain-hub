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
//
// A limit that validateLimit accepts as a digit string must reach the hub as a number:
// the swap and attestation finders bind it into `LIMIT ?`, which MariaDB rejects with
// errno 1064 when the value is a quoted string.

const sinon      = require('sinon');
const { expect } = require('chai');
const { buildCrossChainRpc } = require('../../../src/api/rpc/cross_chain.js');
const { buildAttestationRpc } = require('../../../src/api/rpc/attestation.js');

const FORMS = [['50', 50], ['0050', 50], ['10000', 10000], [50, 50]];

describe('getswaps / getattestations / listxcall digit-string limit', function () {
    for (const status of [undefined, 'pending']) {
        it('getswaps passes a numeric limit (status ' + status + ')', async function () {
            const hub = { getSwaps: sinon.stub().resolves([]) };
            const rpc = buildCrossChainRpc({ hub });
            for (const [s, n] of FORMS) {
                expect(await rpc.getswaps({ status, limit: s })).to.deep.equal([]);
                const arg = hub.getSwaps.lastCall.args[1];
                expect(typeof arg).to.equal('number');
                expect(arg).to.equal(n);
            }
            await rpc.getswaps({ status });
            expect(hub.getSwaps.lastCall.args[1]).to.equal(undefined);
        });

        it('getattestations passes a numeric limit (status ' + status + ')', async function () {
            const cc = { getAttestations: sinon.stub().resolves([]) };
            const rpc = buildAttestationRpc({ hub: { getCrossChain: () => cc } });
            for (const [s, n] of FORMS) {
                expect(await rpc.getattestations({ status, limit: s })).to.deep.equal([]);
                const arg = cc.getAttestations.lastCall.args[1];
                expect(typeof arg).to.equal('number');
                expect(arg).to.equal(n);
            }
            await rpc.getattestations({ status });
            expect(cc.getAttestations.lastCall.args[1]).to.equal(undefined);
        });
    }

    it('listxcall passes a numeric limit', async function () {
        const hub = { crossChainCalls: {}, listCrossChainCalls: sinon.stub().resolves([]) };
        const rpc = buildCrossChainRpc({ hub });
        await rpc.listxcall({ limit: '0050' });
        expect(hub.listCrossChainCalls.lastCall.args[0].limit).to.equal(50);
    });

    it('invalid limits are refused before reaching the hub', async function () {
        const hub = { getSwaps: sinon.stub().resolves([]) };
        const cc = { getAttestations: sinon.stub().resolves([]) };
        const swaps = buildCrossChainRpc({ hub });
        const atts = buildAttestationRpc({ hub: { getCrossChain: () => cc } });
        for (const bad of ['50junk', '1e3', 0, 10001]) {
            expect(await swaps.getswaps({ limit: bad })).to.have.property('error');
            expect(await atts.getattestations({ limit: bad })).to.have.property('error');
        }
        expect(hub.getSwaps.called).to.equal(false);
        expect(cc.getAttestations.called).to.equal(false);
    });
});
