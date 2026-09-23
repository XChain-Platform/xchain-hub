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
// getcrosschaincall and its getxcall alias: a call_id is a 64-char hex sha256, so a
// present but malformed one is refused in the envelope before any read, and a
// well-formed one reaches the hub normalized.

const sinon      = require('sinon');
const { expect } = require('chai');
const { buildCrossChainRpc } = require('../../../src/api/rpc/cross_chain.js');

const CALL_ID = 'ab'.repeat(32);
const METHODS = ['getcrosschaincall', 'getxcall'];

function makeRpc() {
    let hub = {
        crossChainCalls:   {},
        getCrossChainCall: sinon.stub().callsFake(async (id) => (id === CALL_ID ? { call_id: id } : null)),
    };
    return { hub, rpc: buildCrossChainRpc({ hub }) };
}

function registerShapeTests() {
    it('refuses a non-string, a short or non-hex id and a megabyte of junk without reading', async function () {
        for (const m of METHODS) {
            let { hub, rpc } = makeRpc();
            for (const bad of [{}, [], 123, 'ab'.repeat(31), 'zz'.repeat(32), 'x'.repeat(1 << 20)]) {
                let res = await rpc[m]({ call_id: bad });
                expect(res.error, m).to.equal('call_id must be a 64-character hex string');
            }
            expect(hub.getCrossChainCall.called, m).to.equal(false);
        }
    });

    it('keeps the missing-value message', async function () {
        for (const m of METHODS) {
            let { rpc } = makeRpc();
            expect((await rpc[m]({})).error, m).to.equal('call_id is required');
            expect((await rpc[m]({ call_id: '' })).error, m).to.equal('call_id is required');
        }
    });

    it('resolves a well-formed id, upper-case and padded included, as its normalized form', async function () {
        for (const m of METHODS) {
            let { hub, rpc } = makeRpc();
            expect(await rpc[m]({ call_id: CALL_ID })).to.deep.equal({ call_id: CALL_ID });
            expect(await rpc[m]({ call_id: '  ' + CALL_ID.toUpperCase() + ' ' })).to.deep.equal({ call_id: CALL_ID });
            expect(hub.getCrossChainCall.alwaysCalledWith(CALL_ID), m).to.equal(true);
        }
    });

    it('still reports an unknown well-formed id as not found', async function () {
        let { rpc } = makeRpc();
        expect((await rpc.getxcall({ call_id: 'cd'.repeat(32) })).error).to.equal('cross-chain call not found');
    });
}

describe('JSON-RPC cross-chain call reads: call_id shape', registerShapeTests);
