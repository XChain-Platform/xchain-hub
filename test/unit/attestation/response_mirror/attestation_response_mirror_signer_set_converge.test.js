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
 * XChain Hub - ATTEST_RESULT gossip: a held row's signer set converges to the
 * lowest-ranked valid set, whatever order the variants arrive in.
 *
 ********************************************************************/

'use strict';

const sinon        = require('sinon');
const crypto       = require('crypto');
const axios        = require('axios');
const { expect }   = require('chai');
const EventEmitter = require('events');

const AttestationResponseMirror = require('../../../../src/attestation/response_mirror');
const AttestationRound     = require('../../../../src/attestation/round');
const AttestationConsensus = require('../../../../src/attestation/consensus');
const ValidatorIdentity    = require('../../../../src/validators/identity');
const eq                   = require('../../../../src/consensus/equivocation_header.js');
const { buildResponseCanonicalRaw } = require('../../../../src/attestation/attest_response_canonical.js');
const { DB_METHODS } = require('../../../helpers/mockHub.js');

const RID = '11'.repeat(32);
const REQUEST_BLOCK = 120, REQUEST_ACTION = 4400, EFFECTIVE_TIME = 1770000120;
const BODY = 'the agreed body', META = '200', PROVIDER = 'http_get';
const IDENTITIES = ['01', '02', '03', '04'].map(b => new ValidatorIdentity(b.repeat(32)));
const pk = (id) => id.getPubkeyHex().toLowerCase();
// Rank order handed to the mirror: A < B < C < D.
const [A, B, C, D] = IDENTITIES;

function canonical(){
    let raw = buildResponseCanonicalRaw({
        requestId: RID, providerId: PROVIDER,
        responseHash: crypto.createHash('sha256').update(Buffer.from(BODY, 'utf8')).digest('hex'),
        status: 'ok', meta: META, effectiveTime: EFFECTIVE_TIME
    });
    if(eq.isEquivHeaderActive(REQUEST_BLOCK, 'regtest'))
        raw = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RID, 0, raw);
    return raw;
}

function payload(signers, canon){
    let sigs = signers.map(id => ({ pubkey: pk(id), sig: id.sign(canon || canonical()) }));
    return {
        network: 'regtest', request_id: RID, request_action_index: REQUEST_ACTION,
        request_block_index: REQUEST_BLOCK, provider_id: PROVIDER, status: 'ok',
        response_payload: BODY,
        response_hash: crypto.createHash('sha256').update(Buffer.from(BODY, 'utf8')).digest('hex'),
        meta: META, effective_time: EFFECTIVE_TIME,
        signer_pubkeys: JSON.stringify(sigs.map(s => s.pubkey)), signatures: JSON.stringify(sigs), widen: 0
    };
}

function makeDb(){
    let table = [], updates = [];
    return { ...DB_METHODS, table, updates,
        async doQuery(sql, args){
            if(/^INSERT IGNORE INTO attestation_responses/i.test(sql)){
                let cols = sql.substring(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map(s => s.trim());
                let row = {};
                cols.forEach((c, i) => { row[c] = args[i]; });
                if(table.find(r => r.request_id === row.request_id && String(r.effective_time) === String(row.effective_time)))
                    return { affectedRows: 0, insertId: 0 };
                row.id = table.length + 1;
                table.push(row);
                return { affectedRows: 1, insertId: row.id };
            }
            if(/^UPDATE attestation_responses SET signer_pubkeys/i.test(sql)){
                updates.push(args);
                let r = table.find(x => x.request_id === args[3] && String(x.effective_time) === String(args[4]) && x.signatures === args[5]);
                if(!r) return { affectedRows: 0 };
                r.signer_pubkeys = args[0]; r.signatures = args[1];
                return { affectedRows: 1 };
            }
            if(/^SELECT id(,| ).*FROM attestation_responses/i.test(sql)){
                let f = table.find(r => r.request_id === args[1] && String(r.effective_time) === String(args[2]));
                return f ? [Object.assign({}, f)] : [];
            }
            throw new Error('unexpected statement: ' + sql);
        }
    };
}

function makeMirror(){
    let consensus = Object.create(AttestationConsensus.prototype);
    let round = Object.create(AttestationRound.prototype);
    round.computeResponsibleSet = () => [A, B, C].map(id => ({ pubkey: pk(id) }));
    let validators = IDENTITIES.map((id, i) => ({ pubkey: pk(id), source: 's' + i, weight: '100000' }));
    let hub = {
        network: 'regtest', db: makeDb(),
        hubDbBroadcaster: { broadcastRow: sinon.stub() },
        peerManager: Object.assign(new EventEmitter(), { broadcast: sinon.stub() }),
        attestationConsensus: consensus, attestationRound: round,
        capabilitySnapshot: {
            getWeightSnapshot: sinon.stub().resolves({ validators }),
            getSnapshot: sinon.stub().resolves({ validators })
        },
        providerRegistry: { getMinStake: () => '1000' },
        btcIndexerHeaders: () => ({}),
        resolveBtcIndexerUrl: async () => 'http://indexer.invalid/api'
    };
    consensus.hub = hub;
    sinon.stub(axios, 'post').resolves({ data: { result: { latest_block_index: 130, count: 1, requests: [{
        request_id: RID, block_index: REQUEST_BLOCK, action_index: REQUEST_ACTION,
        deadline_block: 200, redundancy: 2, provider_id: PROVIDER, request_status: 'pending' }] } } });
    return { hub, mirror: new AttestationResponseMirror(hub) };
}

const held = (hub) => JSON.parse(hub.db.table[0].signer_pubkeys);

describe('AttestationResponseMirror: signer set convergence', function(){
    afterEach(() => sinon.restore());

    it('replaces a held higher-ranked set with a verified lower-ranked one', async function(){
        let { hub, mirror } = makeMirror();
        await mirror.ingestGossipRow(mirror.parseGossipRow(payload([B, C])), false);
        expect(held(hub)).to.deep.equal([pk(B), pk(C)]);
        await mirror.ingestGossipRow(mirror.parseGossipRow(payload([A, C])), false);
        expect(held(hub)).to.deep.equal([pk(A), pk(C)]);
        expect(hub.db.updates).to.have.length(1);
        expect(hub.hubDbBroadcaster.broadcastRow.callCount).to.equal(2);
    });

    it('converges to the same set in either arrival order', async function(){
        let first = makeMirror();
        await first.mirror.ingestGossipRow(first.mirror.parseGossipRow(payload([A, B])), false);
        await first.mirror.ingestGossipRow(first.mirror.parseGossipRow(payload([B, C])), false);
        sinon.restore();
        let second = makeMirror();
        await second.mirror.ingestGossipRow(second.mirror.parseGossipRow(payload([B, C])), false);
        await second.mirror.ingestGossipRow(second.mirror.parseGossipRow(payload([A, B])), false);
        expect(held(first.hub)).to.deep.equal([pk(A), pk(B)]);
        expect(held(second.hub)).to.deep.equal([pk(A), pk(B)]);
    });

    it('keeps the held set when the incoming one ranks worse', async function(){
        let { hub, mirror } = makeMirror();
        await mirror.ingestGossipRow(mirror.parseGossipRow(payload([A, B])), false);
        await mirror.ingestGossipRow(mirror.parseGossipRow(payload([B, C])), false);
        expect(held(hub)).to.deep.equal([pk(A), pk(B)]);
        expect(hub.db.updates).to.have.length(0);
    });

    it('refuses a better-ranked set whose signatures do not verify', async function(){
        let { hub, mirror } = makeMirror();
        await mirror.ingestGossipRow(mirror.parseGossipRow(payload([B, C])), false);
        let bad = payload([A, C]);
        let sigs = JSON.parse(bad.signatures);
        sigs[0].sig = 'ee'.repeat(64);
        bad.signatures = JSON.stringify(sigs);
        await mirror.ingestGossipRow(mirror.parseGossipRow(bad), false);
        expect(held(hub)).to.deep.equal([pk(B), pk(C)]);
        expect(hub.db.updates).to.have.length(0);
    });
});

describe('AttestationResponseMirror: signer set convergence refusals', function(){
    afterEach(() => sinon.restore());

    it('refuses a set that names a signer outside the responsible set', async function(){
        let { hub, mirror } = makeMirror();
        await mirror.ingestGossipRow(mirror.parseGossipRow(payload([B, C])), false);
        await mirror.ingestGossipRow(mirror.parseGossipRow(payload([A, D])), false);
        expect(held(hub)).to.deep.equal([pk(B), pk(C)]);
    });

    it('refuses a signer_pubkeys list that does not pair with its signatures', async function(){
        let { hub, mirror } = makeMirror();
        await mirror.ingestGossipRow(mirror.parseGossipRow(payload([B, C])), false);
        let liar = payload([B, C]);
        liar.signer_pubkeys = JSON.stringify([pk(A), pk(B)]);
        await mirror.ingestGossipRow(mirror.parseGossipRow(liar), false);
        expect(held(hub)).to.deep.equal([pk(B), pk(C)]);
    });

    it('does not touch the row when the same set arrives again', async function(){
        let { hub, mirror } = makeMirror();
        await mirror.ingestGossipRow(mirror.parseGossipRow(payload([A, B])), false);
        await mirror.ingestGossipRow(mirror.parseGossipRow(payload([B, A])), false);
        expect(hub.db.updates).to.have.length(0);
    });
});
