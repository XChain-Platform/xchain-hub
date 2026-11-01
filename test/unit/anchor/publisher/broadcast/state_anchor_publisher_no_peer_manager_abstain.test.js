'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The bundle and archive publisher-attestation rounds self-attest only on a genuine
// one-member oracle_publish set. With no peer manager a multi-member set abstains before
// the slot claim, since a lone signature is a sub-quorum the indexer credits nothing for.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const ValidatorIdentity    = require('../../../../../src/validators/identity');
const { DB_METHODS }       = require('../../../../helpers/mockHub.js');

const BLOCK = 100;
const CP = { chain: 'BTC', network: 'regtest', block_index: 500, checkpoint_seq: BLOCK, snapshot_block: BLOCK };

// A publisher with no peer manager whose signing set the caller controls; slot claims
// and signatures are counted so an abstain is visible as zero of each.
function buildPub(setFor) {
    let identity = new ValidatorIdentity('11'.repeat(32));
    let hub = {
        db: { ...DB_METHODS, async doQuery() { return []; } },
        network: 'regtest', capabilitySnapshot: null, p2pConfig: {}, rewardTracker: null,
        getIdentity: () => identity,
        getPeerManager: () => null
    };
    let pub = new StateAnchorPublisher(hub);
    let me = identity.getPubkeyHex().toLowerCase();
    let counts = { claims: 0, signs: 0 };
    let set = setFor(me);
    pub.attestationSigningSet        = async () => set;
    pub.archiveAttestationSigningSet = async () => set;
    pub.claimAttestSlot = async () => { counts.claims++; return true; };
    let sign = identity.sign.bind(identity);
    identity.sign = (msg) => { counts.signs++; return sign(msg); };
    return { pub, me, counts };
}

const threeMembers = me => [
    { pubkey: me, amount: '1', source: 's0' },
    { pubkey: '22'.repeat(32), amount: '1', source: 's1' },
    { pubkey: '33'.repeat(32), amount: '1', source: 's2' }
];
const oneMember = me => [{ pubkey: me, amount: '1', source: 's0' }];

describe('StateAnchorPublisher attestation rounds without a peer manager', function () {
    it('the bundle round abstains on a multi-member set before claiming the slot', async function () {
        let { pub, me, counts } = buildPub(threeMembers);
        let res = await pub.runPublisherAttestationRound(CP, me);
        expect(res.met).to.equal(false);
        expect(res.sigs).to.deep.equal([]);
        expect(counts).to.deep.equal({ claims: 0, signs: 0 });
    });

    it('the bundle round still self-attests a one-member set', async function () {
        let { pub, me, counts } = buildPub(oneMember);
        let res = await pub.runPublisherAttestationRound(CP, me);
        expect(res.met).to.equal(true);
        expect(res.sigs.map(s => s.pubkey)).to.deep.equal([me]);
        expect(counts).to.deep.equal({ claims: 1, signs: 1 });
    });

    it('the archive round abstains on a multi-member set before claiming the slot', async function () {
        let { pub, me, counts } = buildPub(threeMembers);
        let res = await pub.runArchiveAttestationRound(CP, 7, me);
        expect(res.met).to.equal(false);
        expect(res.sigs).to.deep.equal([]);
        expect(counts).to.deep.equal({ claims: 0, signs: 0 });
    });

    it('the archive round still self-attests a one-member set', async function () {
        let { pub, me, counts } = buildPub(oneMember);
        let res = await pub.runArchiveAttestationRound(CP, 7, me);
        expect(res.met).to.equal(true);
        expect(res.sigs.map(s => s.pubkey)).to.deep.equal([me]);
        expect(counts).to.deep.equal({ claims: 1, signs: 1 });
    });
});
