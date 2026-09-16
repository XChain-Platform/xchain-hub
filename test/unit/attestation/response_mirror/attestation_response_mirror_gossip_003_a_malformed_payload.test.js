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
 * XChain Hub - ATTEST_RESULT gossip: send, verify, park (the ATTEST response
 * mirror design, §3.3).
 *
 * The signatures here are REAL Ed25519 over a canonical this file builds from
 * the protocol modules directly, never from the engine under test. That is what
 * makes the accept case meaningful: if the engine's canonical drifts from the
 * one AttestationConsensus signs, every accept case in this file reds, which a
 * test that signed whatever the engine asked for could not detect.
 *
 * The responsible-set filter is exercised rather than assumed: four validators
 * hold the capability, all four sign, and only the two the hash ranking selects
 * may be counted. So a passing accept case also proves the filter is not
 * admitting everyone.
 *
 ********************************************************************/

'use strict';

const sinon        = require('sinon');
const crypto       = require('crypto');
const axios        = require('axios');
const { expect }   = require('chai');
const EventEmitter = require('events');

const AttestationResponseMirror = require('../../../../src/attestation/response_mirror');
const { MIRROR_COLUMNS, GOSSIP_COLUMNS, ATTEST_RESULT, PARK_MAX } = AttestationResponseMirror;

const AttestationRound     = require('../../../../src/attestation/round');
const AttestationConsensus = require('../../../../src/attestation/consensus');
const ValidatorIdentity    = require('../../../../src/validators/identity');
const eq                   = require('../../../../src/equivocation_header.js');
const { buildResponseCanonicalRaw } = require('../../../../src/attestation/attest_response_canonical.js');
const { DB_METHODS } = require('../../../helpers/mockHub.js');

const RID            = '11'.repeat(32);
const REQUEST_BLOCK  = 120;
const REQUEST_ACTION = 4400;
const DEADLINE_BLOCK = 200;
const LATEST_BLOCK   = 130;
const EFFECTIVE_TIME = 1770000120;
const BODY           = 'the agreed body';
const META           = '200';
const PROVIDER       = 'http_get';

// Four validators, deterministic seeds so a failure is reproducible.
const IDENTITIES = ['01', '02', '03', '04'].map(b => new ValidatorIdentity(b.repeat(32)));

// ---------------------------------------------------------------------------
// Canonical + row construction, derived from the protocol modules rather than
// from the engine. On regtest the EQUIV header is armed at 0, so the wrapper is
// applied here exactly as AttestationConsensus.buildCanonical applies it.
// ---------------------------------------------------------------------------
function canonicalFor(overrides){
    let o = Object.assign({
        requestId: RID, providerId: PROVIDER, body: BODY, status: 'ok',
        meta: META, effectiveTime: EFFECTIVE_TIME, requestBlock: REQUEST_BLOCK
    }, overrides || {});
    let raw = buildResponseCanonicalRaw({
        requestId:     o.requestId,
        providerId:    o.providerId,
        responseHash:  crypto.createHash('sha256').update(Buffer.from(o.body, 'utf8')).digest('hex'),
        status:        o.status,
        meta:          o.meta,
        effectiveTime: o.effectiveTime
    });
    if(eq.isEquivHeaderActive(o.requestBlock, 'regtest'))
        raw = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, o.requestId, 0, raw);
    return raw;
}

// A wire payload as gossipRow would build one. `signWith` selects which
// identities co-sign; `signCanonical` lets a case sign the WRONG bytes.
function gossipPayload(overrides){
    let o = Object.assign({
        signWith: IDENTITIES, signCanonical: canonicalFor(), network: 'regtest',
        requestBlock: REQUEST_BLOCK, requestAction: REQUEST_ACTION, requestId: RID,
        status: 'ok', body: BODY, meta: META, effectiveTime: EFFECTIVE_TIME
    }, overrides || {});
    let sigs = o.signWith.map(id => ({
        pubkey: id.getPubkeyHex().toLowerCase(),
        sig:    id.sign(o.signCanonical)
    }));
    return {
        network:              o.network,
        request_id:           o.requestId,
        request_action_index: o.requestAction,
        request_block_index:  o.requestBlock,
        provider_id:          PROVIDER,
        status:               o.status,
        response_payload:     o.body,
        response_hash:        crypto.createHash('sha256').update(Buffer.from(o.body, 'utf8')).digest('hex'),
        meta:                 o.meta,
        effective_time:       o.effectiveTime,
        signer_pubkeys:       JSON.stringify(sigs.map(s => s.pubkey)),
        signatures:           JSON.stringify(sigs),
        widen:                0
    };
}

// ---------------------------------------------------------------------------
// A minimal stand-in for the hub's mariadb wrapper. Models AUTO_INCREMENT and
// the UNIQUE (network, request_id) so "already held" and "INSERT IGNORE absorbed
// it" are real outcomes rather than canned stub returns.
// ---------------------------------------------------------------------------
function makeDb(){
    let table = [], nextId = 1, queries = [];
    return { ...DB_METHODS,
        table:   table,
        queries: queries,
        inserts: () => queries.filter(q => /^INSERT/i.test(q.sql)),
        async doQuery(sql, args){
            queries.push({ sql: sql, args: args });
            if(/^INSERT IGNORE INTO attestation_responses/i.test(sql)){
                let cols = sql.substring(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map(s => s.trim());
                let row  = {};
                cols.forEach((c, i) => { row[c] = args[i]; });
                // The key is (network, request_id, effective_time): a second honest
                // variant of a request (another leader slot's stamp) is a fresh row.
                if(table.find(r => r.network === row.network && r.request_id === row.request_id &&
                                   String(r.effective_time) === String(row.effective_time)))
                    return { affectedRows: 0, insertId: 0 };
                row.id = nextId++;
                table.push(row);
                return { affectedRows: 1, insertId: row.id };
            }
            if(/^SELECT id(,| ).*FROM attestation_responses/i.test(sql)){
                if(!/effective_time = \?/.test(sql))
                    throw new Error('a keyed mirror read must name the whole key: ' + sql);
                let found = table.find(r => r.network === args[0] && r.request_id === args[1] &&
                                            String(r.effective_time) === String(args[2]));
                return found ? [Object.assign({}, found)] : [];
            }
            throw new Error('unexpected statement: ' + sql);
        }
    };
}

// The capability snapshot every validator qualifies in. STAKE_WEIGHTED_QUORUM is
// armed at 0 on regtest, so the weighted shape (source + weight) is the one the
// responsible-set rule actually consumes.
function weightedValidators(){
    return IDENTITIES.map((id, i) => ({
        pubkey: id.getPubkeyHex().toLowerCase(),
        source: 'src' + i,
        weight: '100000'
    }));
}

// Split the four validators into the two the deterministic ranking makes
// responsible for RID at redundancy 2 (widen 0) and the two it does not. The rule
// is re-derived here from its definition - sort by SHA256(request_id || pubkey),
// take the top REDUNDANCY - rather than read out of AttestationRound, so a change
// to that rule shows up as a failure here instead of being tracked silently.
function responsibleSplit(){
    let ranked = IDENTITIES
        .map(id => ({
            id:   id,
            hash: crypto.createHash('sha256')
                        .update(RID, 'utf8')
                        .update(id.getPubkeyHex().toLowerCase(), 'utf8')
                        .digest('hex')
        }))
        .sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0));
    return {
        responsible: ranked.slice(0, 2).map(r => r.id),
        outsiders:   ranked.slice(2).map(r => r.id)
    };
}

function makeHub(overrides){
    let consensus = Object.create(AttestationConsensus.prototype);
    let round     = Object.create(AttestationRound.prototype);
    let hub = Object.assign({
        network:              'regtest',
        db:                   makeDb(),
        hubDbBroadcaster:     { broadcastRow: sinon.stub() },
        peerManager:          Object.assign(new EventEmitter(), { broadcast: sinon.stub() }),
        attestationConsensus: consensus,
        attestationRound:     round,
        capabilitySnapshot:   {
            getWeightSnapshot: sinon.stub().resolves({ validators: weightedValidators() }),
            getSnapshot:       sinon.stub().resolves({ validators: weightedValidators() })
        },
        providerRegistry:     { getMinStake: () => '1000' },
        btcIndexerHeaders:   () => ({}),
        resolveBtcIndexerUrl: async () => 'http://indexer.invalid/api'
    }, overrides || {});
    consensus.hub = hub;
    return hub;
}

// The indexer's pending-request page, as getpendingattestation_requests answers.
function stubRequestLookup(rows){
    return sinon.stub(axios, 'post').resolves({
        data: { result: { latest_block_index: LATEST_BLOCK, count: rows.length, requests: rows } }
    });
}

function localRequest(overrides){
    return Object.assign({
        request_id:     RID,
        block_index:    REQUEST_BLOCK,
        action_index:   REQUEST_ACTION,
        deadline_block: DEADLINE_BLOCK,
        redundancy:     2,
        provider_id:    PROVIDER,
        request_status: 'pending'
    }, overrides || {});
}

function finalizedEvent(overrides){
    return Object.assign({
        requestId:     RID,
        request:       { block_index: REQUEST_BLOCK, action_index: REQUEST_ACTION, redundancy: 2 },
        providerId:    PROVIDER,
        responseBody:  Buffer.from(BODY, 'utf8'),
        meta:          META,
        status:        'ok',
        signatures:    IDENTITIES.map(id => ({ pubkey: id.getPubkeyHex(), sig: 'ee'.repeat(64) })),
        effectiveTime: EFFECTIVE_TIME,
        widen:         0
    }, overrides || {});
}

function settle(){
    return new Promise(resolve => setImmediate(resolve));
}

{
const hookAt10730 = function () {
        sinon.restore();
    };

const CASES = {
            'a request id that is not 64-hex':      { request_id: 'nope' },
            'a non-terminal status':                { status: 'no_quorum' },
            'a null effective_time':                { effective_time: null },
            'an empty-string effective_time':       { effective_time: '' },
            'a fractional effective_time':          { effective_time: 1.5 },
            'a response_hash that is not 64-hex':   { response_hash: 'zz' },
            'a signatures column that is not JSON': { signatures: '{' },
            'an empty signature array':             { signatures: '[]' },
            'a signature entry of the wrong shape': { signatures: JSON.stringify([{ pubkey: 'aa', sig: 'bb' }]) },
            'no provider id':                       { provider_id: '' }
        };

// ── structural rejection, before anything is spent ───────────────────────
describe('AttestationResponseMirror: ATTEST_RESULT gossip', function () { afterEach(hookAt10730); describe('a malformed payload', function () { Object.keys(CASES).forEach(name => {
            it('rejects ' + name + ' without any indexer lookup', async function () {
                let hub    = makeHub();
                let mirror = new AttestationResponseMirror(hub);
                let post   = stubRequestLookup([localRequest()]);
                await mirror.start();

                await mirror.handleResult({ type: ATTEST_RESULT, data: Object.assign(gossipPayload(), CASES[name]) });

                expect(hub.db.table).to.have.length(0);
                expect(post.callCount).to.equal(0);
                expect(mirror.stats.rejected).to.equal(1);
            });
        }); }); });
}
