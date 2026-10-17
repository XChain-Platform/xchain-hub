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
 **********************************************************************/

'use strict';

const crypto = require('crypto');
const sinon = require('sinon');
const { expect } = require('chai');

const seed = require('../../../../src/attestation/response_mirror/seed_undelivered.js');

async function thrownBy(run){
    try {
        await run();
    } catch (err) {
        return err;
    }
    return null;
}

function stubDb(held = []){
    return {
        getAttestationResponseMirrorRow: sinon.stub().resolves(held),
        createAttestationResponseMirrorRow: sinon.stub().resolves({ affectedRows: 1 })
    };
}

describe('Seed undelivered attestation response', function () {
    it('refuses every network it cannot identify exactly before calling the database', async function () {
        for(const network of ['mainnet', 'mainnet ', 'Testnet', 'regtestnet', '', undefined]){
            const db = stubDb();
            const err = await thrownBy(() => seed.seedUndeliveredResponse(db, { network }));
            expect(err).to.be.instanceOf(seed.SeedNetworkError);
            expect(err.name).to.equal('SeedNetworkError');
            expect(db.getAttestationResponseMirrorRow.called).to.equal(false);
            expect(db.createAttestationResponseMirrorRow.called).to.equal(false);
        }
    });

    it('accepts only exact testnet and regtest names', function () {
        expect(seed.assertSeedableNetwork('testnet')).to.equal('testnet');
        expect(seed.assertSeedableNetwork('regtest')).to.equal('regtest');
    });

    it('builds a fresh lower-case 32-byte request id for every row', function () {
        const first = seed.buildSeedRow('testnet', 1770000000);
        const second = seed.buildSeedRow('testnet', 1770000000);
        expect(first.request_id).to.match(/^[0-9a-f]{64}$/);
        expect(second.request_id).to.match(/^[0-9a-f]{64}$/);
        expect(first.request_id).not.to.equal(second.request_id);
    });

    it('builds the inert marker row and hashes its payload bytes', function () {
        const row = seed.buildSeedRow('regtest', 1770000123, () => Buffer.alloc(32, 0xab));
        expect(row).to.include({
            network: 'regtest',
            provider_id: 'seed_probe',
            status: 'ok',
            meta: JSON.stringify({ seeded: 'hub-seed-undelivered' }),
            effective_time: 1770000123,
            finalized_at: 1770000123,
            signer_pubkeys: '[]',
            signatures: '[]',
            widen: 0
        });
        expect(row.request_action_index).to.equal(null);
        expect(row.request_block_index).to.equal(null);
        expect(row.admit_block_btc).to.equal(null);
        expect(row.response_hash).to.equal(
            crypto.createHash('sha256').update(row.response_payload).digest('hex'));
    });

    it('checks for a held id but writes nothing during a dry run', async function () {
        const db = stubDb();
        const row = await seed.seedUndeliveredResponse(db, {
            network: 'testnet', nowSeconds: 1770000124, randomBytes: () => Buffer.alloc(32, 1)
        });
        expect(db.getAttestationResponseMirrorRow.calledOnceWith(
            'testnet', row.request_id, 1770000124)).to.equal(true);
        expect(db.createAttestationResponseMirrorRow.called).to.equal(false);
    });

    it('writes exactly the built row once in apply mode', async function () {
        const db = stubDb();
        const row = await seed.seedUndeliveredResponse(db, {
            network: 'regtest', apply: true, nowSeconds: 1770000125,
            randomBytes: () => Buffer.alloc(32, 2)
        });
        expect(db.createAttestationResponseMirrorRow.calledOnceWithExactly(row)).to.equal(true);
    });

    it('refuses a held id without attempting a write', async function () {
        const db = stubDb([{ id: 7 }]);
        const err = await thrownBy(() => seed.seedUndeliveredResponse(db, {
            network: 'testnet', apply: true, nowSeconds: 1770000126,
            randomBytes: () => Buffer.alloc(32, 3)
        }));
        expect(err).to.be.instanceOf(seed.SeedCollisionError);
        expect(db.getAttestationResponseMirrorRow.calledOnce).to.equal(true);
        expect(db.createAttestationResponseMirrorRow.called).to.equal(false);
    });
});
