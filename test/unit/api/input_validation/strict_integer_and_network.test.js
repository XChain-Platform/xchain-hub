/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const { strictInt } = require('../../../../src/api/validate.js');
const { buildFeedRpc } = require('../../../../src/api/rpc/feed.js');
const { buildAttestationRpc } = require('../../../../src/api/rpc/attestation.js');

function feedHarness() {
    const db = {
        setChainTip: sinon.stub().resolves(),
        getChainTip: sinon.stub().resolves(null)
    };
    const hub = { network: 'mainnet', db };
    return { rpc: buildFeedRpc({ hub }), db };
}

async function rejected(call) {
    try {
        await call;
    } catch (error) {
        return error;
    }
    throw new Error('expected JSON-RPC parameter refusal');
}

describe('API exact integer and chain-tip network validation', function () {

    afterEach(function () { sinon.restore(); });

    it('rejects integers that a JavaScript Number cannot represent exactly', async function () {
        const unsafe = [Number.MAX_SAFE_INTEGER + 1, '9007199254740992', '1000000000000000000000'];
        const requestAttestation = sinon.stub().resolves({ status: 'attested' });
        const attestation = buildAttestationRpc({ hub: { requestAttestation } });
        const { rpc, db } = feedHarness();
        for (const value of unsafe) {
            expect(strictInt(value), String(value)).to.equal(null);
            expect((await attestation.requestattestation({
                source_chain: 'BTC', source_action_index: value, dest_chain: 'LTC'
            })).error).to.include('source_action_index');
            expect((await rpc.pushchaintip({
                coin: 'BTC', network: 'mainnet', block_height: value, block_time: 1700000000
            })).error).to.include('invalid block_height');
        }
        expect(requestAttestation.called).to.equal(false);
        expect(db.setChainTip.called).to.equal(false);
    });

    it('refuses caller-supplied phantom networks before writing', async function () {
        const { rpc, db } = feedHarness();
        for (const network of ['devnet', '', 7, { name: 'mainnet' }]) {
            const error = await rejected(rpc.pushchaintip({
                coin: 'BTC', network, block_height: 850000, block_time: 1700000000
            }));
            expect(error.code, String(network)).to.equal(-32602);
            expect(error.message).to.include('network must be one of');
        }
        expect(db.setChainTip.called).to.equal(false);
    });

    it('keeps the omitted-network compatibility default', async function () {
        const { rpc, db } = feedHarness();
        expect(await rpc.pushchaintip({
            coin: 'BTC', block_height: 850000, block_time: 1700000000
        })).to.deep.equal({ status: 'success' });
        expect(db.setChainTip.firstCall.args.slice(0, 4))
            .to.deep.equal(['BTC', 'mainnet', 850000, 1700000000]);
    });
});
