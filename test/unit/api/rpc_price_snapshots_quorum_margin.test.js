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
const { buildOracleRpc } = require('../../../src/api/rpc/oracle.js');

const sigs = (...pubkeys) => JSON.stringify(pubkeys.map(pubkey => ({ pubkey, sig: 'sig' })));
const validators = (...pubkeys) => pubkeys.map(pubkey => ({ pubkey }));

function row(overrides) {
    return Object.assign({
        round_number: 7,
        coin_pair: 'BTC/USD',
        status: 'finalized',
        reference_block: 10,
        consensus_proof: sigs('a', 'b', 'c'),
    }, overrides);
}

function fixture(rows, network) {
    const capabilitySnapshot = {
        getSnapshot: sinon.stub().resolves({ validators: validators('a', 'b', 'c', 'd') }),
        getWeightSnapshot: sinon.stub(),
    };
    const hub = {
        network: network || 'mainnet',
        capabilitySnapshot,
        getPriceSnapshots: sinon.stub().resolves(rows),
        oracleMaxAgeSecondsInForce: sinon.stub().resolves(900),
    };
    return { hub, capabilitySnapshot, rpc: buildOracleRpc({ hub }) };
}

describe('getpricesnapshots quorum margin', function () {
    it('leaves the historical rows untouched when the option is omitted', async function () {
        const rows = [row()];
        const { rpc, capabilitySnapshot } = fixture(rows);
        const out = await rpc.getpricesnapshots({});
        expect(out).to.equal(rows);
        expect(out[0]).not.to.have.property('quorum_margin');
        expect(capabilitySnapshot.getSnapshot.called).to.equal(false);
    });

    it('adds a count-mode margin and reuses it for every pair in the round', async function () {
        const rows = [row(), row({ coin_pair: 'DOGE/USD' })];
        const { rpc, capabilitySnapshot } = fixture(rows);
        const out = await rpc.getpricesnapshots({ with_quorum_margin: true });
        expect(out[0].quorum_margin).to.deep.equal({
            mode: 'count', met: true, oneFaultTolerant: false, signers: 3, quorum: 3,
        });
        expect(out[1].quorum_margin).to.deep.equal(out[0].quorum_margin);
        expect(capabilitySnapshot.getSnapshot.calledOnceWithExactly('price', 10)).to.equal(true);
        expect(rows[0]).not.to.have.property('quorum_margin');
    });

    it('reports a signer to spare in count mode', async function () {
        const { rpc } = fixture([row({ consensus_proof: sigs('a', 'b', 'c', 'd') })]);
        const out = await rpc.getpricesnapshots({ with_quorum_margin: true });
        expect(out[0].quorum_margin).to.include({ met: true, oneFaultTolerant: true, signers: 4 });
    });
});

describe('getpricesnapshots quorum margin', function () {
    it('uses the batch BTC anchor for a stake-mode margin', async function () {
        const proof = JSON.stringify({
            batch: { first_round: 7, last_round: 8, btc_block_height: 20 },
            sigs: [{ pubkey: 'a', sig: 'sig' }, { pubkey: 'b', sig: 'sig' }],
        });
        const { rpc, capabilitySnapshot } = fixture([row({ reference_block: 999, consensus_proof: proof })], 'regtest');
        capabilitySnapshot.getWeightSnapshot.resolves({
            validators: [
                { pubkey: 'a', source: 'A', weight: '70' },
                { pubkey: 'b', source: 'B', weight: '10' },
                { pubkey: 'c', source: 'C', weight: '10' },
                { pubkey: 'd', source: 'D', weight: '10' },
            ],
        });
        const out = await rpc.getpricesnapshots({ with_quorum_margin: true });
        expect(out[0].quorum_margin).to.deep.equal({
            mode: 'stake', met: true, oneFaultTolerant: false, signers: 2,
        });
        expect(capabilitySnapshot.getWeightSnapshot.calledOnceWithExactly('price', 20)).to.equal(true);
        expect(capabilitySnapshot.getSnapshot.called).to.equal(false);
    });

    it('returns null when a row or its historical validator snapshot cannot be judged', async function () {
        const rows = [
            row({ status: 'skipped', consensus_proof: '[]' }),
            row({ round_number: 8, consensus_proof: 'not json' }),
            row({ round_number: 9, reference_block: 11 }),
        ];
        const { rpc, capabilitySnapshot } = fixture(rows);
        capabilitySnapshot.getSnapshot.withArgs('price', 11).rejects(new Error('indexer down'));
        const out = await rpc.getpricesnapshots({ with_quorum_margin: true });
        expect(out.map(item => item.quorum_margin)).to.deep.equal([null, null, null]);
    });

    it('composes with the watermark envelope', async function () {
        const { rpc } = fixture([row()]);
        const out = await rpc.getpricesnapshots({ with_watermark: true, with_quorum_margin: true });
        expect(out.snapshots[0].quorum_margin).to.include({ mode: 'count' });
        expect(out).to.have.keys('watermark', 'oracleMaxPriceAgeSeconds', 'snapshots');
    });
});
