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
 *
 * XChain Hub - AttestationBatchPublisher: co-signing a window whose rows finalized
 * under different signer subsets on different hubs.
 *
 * At redundancy 3 with a widened responsible set of 4, each hub finalizes on the first
 * three valid signatures it receives, so the leader and a follower hold the same row,
 * byte-identical in content, with different signer lists. The co-signer used to
 * byte-compare those lists and refuse every such window (`differs on signer_pubkeys`,
 * regtest at5 run with response redundancy 3). The signatures here are real ones over
 * the canonical AttestationConsensus builds, so a verifier that checked the wrong
 * bytes reds the accept cases.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const { expect } = require('chai');

const AttestationBatchPublisher = require('../../../../src/attestation/batch_publisher.js');
const AttestationConsensus      = require('../../../../src/attestation/consensus');
const ValidatorIdentity         = require('../../../../src/validators/identity.js');
const ah                        = require('../../../../src/lib/admission_height.js');
const { DB_METHODS }            = require('../../../helpers/mockHub.js');

const WINDOW_S = 10;
const ANCHOR   = 941234;
const START    = 200 * WINDOW_S;

function makeDb(rows){
    return { ...DB_METHODS,
        async getChainTip(){ return { blockHeight: ANCHOR, blockTime: 1 }; },
        async doQuery(sql){
            if(/FROM attestation_responses/i.test(sql)) return rows.map(r => Object.assign({}, r));
            return [];
        }
    };
}

// A hub whose identity is `me` and whose attestation set at every height is `members`.
function makeHub(me, members, rows, sent){
    let snapshot = {
        validators: members.map((id, i) => ({ pubkey: id.getPubkeyHex().toLowerCase(),
                                               weight: '100', amount: '100', source: 'src' + i })),
        count: members.length
    };
    let hub = {
        network:  'regtest',
        db:       makeDb(rows),
        p2pConfig: { ATTEST_BATCH_WINDOW_S_OVERRIDE: String(WINDOW_S), ORACLE_BATCH_SIGN_TIMEOUT_MS: '40' },
        getIdentity: () => me,
        capabilitySnapshot: { async getWeightSnapshot(){ return snapshot; }, async getSnapshot(){ return snapshot; } },
        peerManager: { on(){}, removeListener(){}, broadcast(type, data){ sent.push({ type, data }); } }
    };
    hub.attestationConsensus = Object.create(AttestationConsensus.prototype);
    hub.attestationConsensus.hub = hub;
    return hub;
}

function baseRow(){
    return {
        network:              'regtest',
        request_id:           crypto.randomBytes(32).toString('hex'),
        request_action_index: 4400,
        request_block_index:  120,
        provider_id:          'http_get',
        status:               'ok',
        response_payload:     '{"ok":true}',
        response_hash:        crypto.createHash('sha256').update('{"ok":true}').digest('hex'),
        meta:                 '200',
        effective_time:       START + 3,
        admit_block_btc:      118,
        widen:                1
    };
}

// The row as a hub that finalized on `signers` stores it (build.js: sorted by pubkey,
// signer_pubkeys index for index with signatures).
function signedCopy(row, signers, consensus){
    let canonical = consensus.buildCanonical(row.request_id, row.provider_id, Buffer.from(row.response_payload, 'utf8'),
        row.status, row.meta, row.request_block_index, row.effective_time, ah.rowAdmitBlocks(row)).toString('utf8');
    let sigs = signers.map(id => ({ pubkey: id.getPubkeyHex().toLowerCase(), sig: id.sign(canonical) }))
                      .sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1));
    return Object.assign({}, row, {
        signer_pubkeys: JSON.stringify(sigs.map(s => s.pubkey)),
        signatures:     JSON.stringify(sigs)
    });
}

// Leader and follower each hold their own copy of one logical row; returns what the
// follower did with the leader's proposal.
async function coSign(ids, leaderCopy, followerCopy, extraMembers){
    let members = ids.concat(extraMembers || []);
    let leaderSent = [], followerSent = [];
    let leader   = new AttestationBatchPublisher(makeHub(ids[0], members, [leaderCopy], leaderSent));
    let follower = new AttestationBatchPublisher(makeHub(ids[1], members, [followerCopy], followerSent));
    follower._persistedAnchors = new Set([ANCHOR]);
    let rows = leader.wireRows(await leader.selectWindowRows(START, START + WINDOW_S));
    await follower.handleSignReq({
        type: AttestationBatchPublisher.XATTESTB_SIGN_REQ,
        sig_pubkey: ids[0].getPubkeyHex().toLowerCase(),
        data: { network: 'regtest', window_start: START, window_end: START + WINDOW_S,
                row_count: rows.length, btc_block_height: ANCHOR, rows: rows }
    });
    return { follower, sent: followerSent };
}

function identities(n){
    return Array.from({ length: n }, () => new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex));
}

describe('AttestationBatchPublisher: co-signing across different signer subsets', function () {
    let ids, consensus, row;
    beforeEach(function () {
        ids = identities(5);
        consensus = makeHub(ids[0], ids, [], []).attestationConsensus;
        row = baseRow();
    });

    it('co-signs a window whose one row the two hubs finalized under different signer subsets', async function () {
        let r = await coSign(ids, signedCopy(row, [ids[0], ids[2], ids[3]], consensus),
                                  signedCopy(row, [ids[1], ids[2], ids[3]], consensus));
        expect(r.follower.stats.signRefusals, 'an honest signer-subset difference must not be refused').to.equal(0);
        expect(r.sent.map(s => s.type)).to.deep.equal([AttestationBatchPublisher.XATTESTB_SIGN]);
    });

    it('co-signs a three-signer proposal when this hub finalized with four', async function () {
        let r = await coSign(ids, signedCopy(row, [ids[0], ids[1], ids[3]], consensus),
                                  signedCopy(row, [ids[0], ids[1], ids[2], ids[3]], consensus));
        expect(r.follower.stats.signRefusals).to.equal(0);
        expect(r.sent.length).to.equal(1);
    });

    it('ignores a widen difference and reports no signer check for identical signers', function () {
        let p = new AttestationBatchPublisher(makeHub(ids[1], ids, [], []));
        let mine = signedCopy(row, [ids[0], ids[1], ids[2]], consensus);
        let theirs = Object.assign({}, mine, { widen: 2 });
        expect(p.matchesLocalWindow([theirs], [mine])).to.deep.equal({ ok: true, why: null });
    });

});

describe('AttestationBatchPublisher: refusing a signer set that does not hold up', function () {
    let ids, consensus, row;
    beforeEach(function () {
        ids = identities(5);
        consensus = makeHub(ids[0], ids, [], []).attestationConsensus;
        row = baseRow();
    });

    it('refuses a proposed signature that does not verify over the row', async function () {
        let bad = signedCopy(row, [ids[0], ids[2], ids[3]], consensus);
        let sigs = JSON.parse(bad.signatures);
        sigs[0].sig = (sigs[0].sig[0] === 'a' ? 'b' : 'a') + sigs[0].sig.substring(1);
        bad.signatures = JSON.stringify(sigs);
        let r = await coSign(ids, bad, signedCopy(row, [ids[1], ids[2], ids[3]], consensus));
        expect(r.follower.stats.signRefusals).to.equal(1);
        expect(r.sent.length).to.equal(0);
    });

    it('refuses a signer that holds no attestation at the anchor', async function () {
        let outsider = identities(1)[0];
        let leaderCopy = signedCopy(row, [ids[0], ids[2], outsider], consensus);
        let leaderSent = [], followerSent = [];
        let leader   = new AttestationBatchPublisher(makeHub(ids[0], ids, [leaderCopy], leaderSent));
        let follower = new AttestationBatchPublisher(makeHub(ids[1], ids,
            [signedCopy(row, [ids[1], ids[2], ids[3]], consensus)], followerSent));
        let rows = leader.wireRows(await leader.selectWindowRows(START, START + WINDOW_S));
        let mine = await follower.selectWindowRows(START, START + WINDOW_S);
        let v = follower.coSignVerdict(rows, mine, await follower.resolveAttestationSet(ANCHOR));
        expect(v.ok).to.equal(false);
        expect(v.why).to.match(/holds no attestation at the anchor/);
    });

    it('refuses signer_pubkeys that do not pair with the signatures', async function () {
        let bad = signedCopy(row, [ids[0], ids[2], ids[3]], consensus);
        bad.signer_pubkeys = JSON.stringify(JSON.parse(bad.signer_pubkeys).reverse());
        let r = await coSign(ids, bad, signedCopy(row, [ids[1], ids[2], ids[3]], consensus));
        expect(r.follower.stats.signRefusals).to.equal(1);
        expect(r.sent.length).to.equal(0);
    });

    it('still refuses a content difference that rides along with a signer difference', async function () {
        let altered = signedCopy(Object.assign({}, row, { meta: '201' }), [ids[0], ids[2], ids[3]], consensus);
        let p = new AttestationBatchPublisher(makeHub(ids[1], ids, [], []));
        let v = p.matchesLocalWindow([altered], [signedCopy(row, [ids[1], ids[2], ids[3]], consensus)]);
        expect(v.ok).to.equal(false);
        expect(v.why).to.match(/differs on meta/);
    });
});
