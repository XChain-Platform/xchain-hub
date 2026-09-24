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
 * test/unit/attestation/publisher/batch/attest_batch_wire_era.test.js
 *
 * The hub half of the ATTEST batch admission-era rule: this hub SIGNS the batch, so
 * below the BTC mirror-admission producer activation it must sign the legacy bytes
 * every indexer on the fleet rebuilds (v0.19.0 included), and at or above it the bytes
 * that carry each row's real admit_block_btc. And this hub RE-VERIFIES a batch an
 * indexer pushes back from chain, so a batch a v0.19.0 hub signed has to verify here.
 * Driven on the shipped testnet height with the real gate; the indexer twin of this
 * rule is xchain-indexer test/unit/actions/attest/attest_batch_wire_era.test.js.
 ********************************************************************/

'use strict';

const { expect } = require('chai');

const abw = require('../../../../../src/lib/attest_batch_wire.js');
const adm = require('../../../../../src/consensus/gates/mirror_admission_gate.js');
const signing = require('../../../../../src/attestation/batch_publisher/signing.js');
const windows = require('../../../../../src/attestation/batch_publisher/window.js');
const ValidatorIdentity = require('../../../../../src/validators/identity.js');
const HISTORY = require('../../../../fixtures/attest_batch_v0190_replay.json');

const { isAdmissionEra } = adm;
const NETWORK  = 'testnet';
const ADMIT_AT = adm.MIRROR_ADMISSION_ACTIVATION['BTC:' + NETWORK];

// A stored attestation_responses row as the driver hands it back, admission height and all.
function storedRow(i, admitBlock){
    return {
        network: NETWORK, request_id: String(i).repeat(64).slice(0, 64), request_action_index: '4400',
        request_block_index: String(ADMIT_AT - 10 + i), provider_id: 'http_get', status: 'ok',
        response_payload: '{"ok":true}', response_hash: 'cd'.repeat(32), meta: '200',
        effective_time: String(1789203600 + i), admit_block_btc: admitBlock,
        signer_pubkeys: '[]', signatures: '[]', widen: '0', batch_action_index: null, finalized_at: 1
    };
}

// The leader's own signing round on a one-member set: the single-member path returns
// this hub's signature over exactly the canonical it built.
async function leaderSignature(anchor, rows){
    const identity = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
    const me = identity.getPubkeyHex().toLowerCase();
    const ctx = Object.assign({}, windows, signing, {
        identity, stats: { signRounds: 0, signQuorums: 0 },
        hubPeerManager: () => null,
        resolveAttestationSet: async () => [{ pubkey: me, source: 'S', weight: '1' }]
    });
    const window = { network: NETWORK, window_start: 1789203600, window_end: 1789207200,
                     row_count: rows.length, btc_block_height: anchor, rows: rows.map(r => ctx.normalizeRow(r)) };
    const signed = await ctx.collectBatchSignatures(window, 'k');
    expect(signed.met).to.equal(true);
    return { window, identity, sig: signed.sigs[0].sig };
}

// The canonical an indexer that has never heard of admit_block_btc rebuilds: the legacy
// field order, spelled here from the frozen list rather than from the builder under test.
function legacyCanonical(window){
    return JSON.stringify({
        network: window.network, window_start: window.window_start, window_end: window.window_end,
        row_count: window.row_count, btc_block_height: window.btc_block_height,
        rows: window.rows.map(r => Object.fromEntries(abw.ATTEST_BATCH_LEGACY_ROW_FIELDS.map(f => [f, r[f] === undefined ? null : r[f]])))
    });
}

describe('ATTEST batch wire: the hub signs the era of the batch anchor @regression', function () {

    it('normalizes the stored admission height onto the row, as an integer or null', function () {
        expect(windows.normalizeRow(storedRow(1, '154300')).admit_block_btc).to.equal(154300);
        expect(windows.normalizeRow(storedRow(1, null)).admit_block_btc).to.equal(null);
    });

    it('below the activation the leader signs the legacy bytes, even for a row holding a height', async function () {
        const { window, identity, sig } = await leaderSignature(ADMIT_AT - 1, [storedRow(1, null), storedRow(2, ADMIT_AT)]);
        expect(ValidatorIdentity.verify(legacyCanonical(window), sig, identity.getPubkeyHex())).to.equal(true);
        expect(abw.buildAttestBatchBody(window, isAdmissionEra)).to.not.include('admit_block_btc');
    });

    it('at the activation the leader signs each row\'s real admission height', async function () {
        const { window, identity, sig } = await leaderSignature(ADMIT_AT, [storedRow(1, ADMIT_AT), storedRow(2, null)]);
        const canonical = abw.buildAttestBatchCanonical(window, isAdmissionEra);
        expect(JSON.parse(canonical).rows.map(r => r.admit_block_btc)).to.deep.equal([ADMIT_AT, null]);
        expect(ValidatorIdentity.verify(canonical, sig, identity.getPubkeyHex())).to.equal(true);
        expect(ValidatorIdentity.verify(legacyCanonical(window), sig, identity.getPubkeyHex())).to.equal(false);
    });

    it('a batch a v0.19.0 hub signed before the activation re-verifies here from its own rows', function () {
        expect(HISTORY.btc_block_height).to.be.below(ADMIT_AT);
        const head = abw.parseAttestBatchHead(HISTORY.wire.split('|').slice(1));
        const back = abw.reassembleAttestBatch(head, [], isAdmissionEra);
        expect(back.ok, back.status).to.equal(true);
        // The pushed payload carries the reassembled rows verbatim, which is what
        // response_mirror/batch.js rebuilds the canonical from.
        const canonical = abw.buildAttestBatchCanonical({
            network: back.batch.network, window_start: back.batch.window_start, window_end: back.batch.window_end,
            row_count: back.batch.row_count, btc_block_height: head.btcBlockHeight, rows: back.batch.rows
        }, isAdmissionEra);
        expect(canonical).to.equal(HISTORY.signed_canonical);
        expect(ValidatorIdentity.verify(canonical, back.batch.sigs[0].sig, HISTORY.signer_pubkey)).to.equal(true);
    });
});
