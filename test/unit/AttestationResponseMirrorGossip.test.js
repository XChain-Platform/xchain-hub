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

const AttestationResponseMirror = require('../../src/AttestationResponseMirror');
const { MIRROR_COLUMNS, GOSSIP_COLUMNS, ATTEST_RESULT, PARK_MAX } = AttestationResponseMirror;

const AttestationRound     = require('../../src/AttestationRound');
const AttestationConsensus = require('../../src/AttestationConsensus');
const ValidatorIdentity    = require('../../src/ValidatorIdentity');
const eq                   = require('../../src/equivocation_header.js');
const { buildResponseCanonicalRaw } = require('../../src/attest_response_canonical.js');

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
// applied here exactly as AttestationConsensus._buildCanonical applies it.
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

// A wire payload as _gossipRow would build one. `signWith` selects which
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
    return {
        table:   table,
        queries: queries,
        inserts: () => queries.filter(q => /^INSERT/i.test(q.sql)),
        async doQuery(sql, args){
            queries.push({ sql: sql, args: args });
            if(/^INSERT IGNORE INTO attestation_responses/i.test(sql)){
                let cols = sql.substring(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map(s => s.trim());
                let row  = {};
                cols.forEach((c, i) => { row[c] = args[i]; });
                if(table.find(r => r.network === row.network && r.request_id === row.request_id))
                    return { affectedRows: 0, insertId: 0 };
                row.id = nextId++;
                table.push(row);
                return { affectedRows: 1, insertId: row.id };
            }
            if(/^SELECT id(,| ).*FROM attestation_responses/i.test(sql)){
                let found = table.find(r => r.network === args[0] && r.request_id === args[1]);
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
        _btcIndexerHeaders:   () => ({}),
        _resolveBtcIndexerUrl: async () => 'http://indexer.invalid/api'
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

describe('AttestationResponseMirror: ATTEST_RESULT gossip', function () {

    afterEach(function () {
        sinon.restore();
    });

    // ── send ────────────────────────────────────────────────────────────────

    describe('the send half', function () {

        it('gossips exactly one ATTEST_RESULT after a NEW local insert', async function () {
            let hub    = makeHub();
            let mirror = new AttestationResponseMirror(hub);
            await mirror.start();

            hub.attestationConsensus.emit('request:finalized', finalizedEvent());
            await settle();

            let calls = hub.peerManager.broadcast.getCalls();
            expect(calls).to.have.length(1);
            expect(calls[0].args[0]).to.equal(ATTEST_RESULT);
            expect(mirror.stats.gossiped).to.equal(1);
        });

        it('carries every mirrored column except finalized_at, which is the receiver\'s own stamp', async function () {
            let hub    = makeHub();
            let mirror = new AttestationResponseMirror(hub);
            await mirror.start();

            hub.attestationConsensus.emit('request:finalized', finalizedEvent());
            await settle();

            let data = hub.peerManager.broadcast.getCall(0).args[1];
            expect(Object.keys(data).sort()).to.deep.equal(GOSSIP_COLUMNS.slice().sort());
            expect(GOSSIP_COLUMNS).to.not.include('finalized_at');
            // The derived wire set must stay the mirrored set minus that one column,
            // or a schema addition would silently stop travelling.
            expect(GOSSIP_COLUMNS.length).to.equal(MIRROR_COLUMNS.length - 1);
            expect(data.request_id).to.equal(RID);
            expect(data.effective_time).to.equal(EFFECTIVE_TIME);
        });

        it('does not gossip again when the same round re-finalizes (INSERT IGNORE absorbed it)', async function () {
            let hub    = makeHub();
            let mirror = new AttestationResponseMirror(hub);
            await mirror.start();

            hub.attestationConsensus.emit('request:finalized', finalizedEvent());
            await settle();
            hub.attestationConsensus.emit('request:finalized', finalizedEvent());
            await settle();

            expect(hub.peerManager.broadcast.callCount).to.equal(1);
        });

        it('does not gossip a round the mirror declines to write', async function () {
            let hub    = makeHub();
            let mirror = new AttestationResponseMirror(hub);
            await mirror.start();

            hub.attestationConsensus.emit('request:finalized', finalizedEvent({ status: 'no_quorum' }));
            await settle();

            expect(hub.peerManager.broadcast.callCount).to.equal(0);
            expect(hub.db.table).to.have.length(0);
        });
    });

    // ── receive ─────────────────────────────────────────────────────────────

    describe('the receive half', function () {

        it('inserts a valid row and streams it to WS subscribers without re-gossiping it', async function () {
            let hub    = makeHub();
            let mirror = new AttestationResponseMirror(hub);
            stubRequestLookup([localRequest()]);
            await mirror.start();

            await mirror._handleResult({ type: ATTEST_RESULT, data: gossipPayload() });

            expect(hub.db.table).to.have.length(1);
            expect(hub.db.table[0].request_id).to.equal(RID);
            expect(hub.hubDbBroadcaster.broadcastRow.callCount).to.equal(1);
            expect(hub.hubDbBroadcaster.broadcastRow.getCall(0).args[0].table).to.equal('attestation_responses');
            // The received artifact must not travel on: every hub is already one hop
            // from every producer, so a forward is pure amplification.
            expect(hub.peerManager.broadcast.callCount).to.equal(0);
        });

        it('stamps its OWN finalized_at and re-states the informational columns from the local request', async function () {
            let hub    = makeHub();
            let mirror = new AttestationResponseMirror(hub);
            stubRequestLookup([localRequest()]);
            await mirror.start();
            sinon.stub(mirror, '_nowSeconds').returns(1780000000);

            // The wire claims a different position; the local request row wins.
            await mirror._handleResult({ type: ATTEST_RESULT, data: gossipPayload({ requestAction: REQUEST_ACTION }) });

            let stored = hub.db.table[0];
            expect(Number(stored.finalized_at)).to.equal(1780000000);
            expect(Number(stored.request_block_index)).to.equal(REQUEST_BLOCK);
            expect(Number(stored.request_action_index)).to.equal(REQUEST_ACTION);
        });

        it('admits a quorum drawn from the ranked responsible slice', async function () {
            let hub    = makeHub();
            let mirror = new AttestationResponseMirror(hub);
            stubRequestLookup([localRequest()]);
            await mirror.start();

            await mirror._handleResult({
                type: ATTEST_RESULT,
                data: gossipPayload({ signWith: responsibleSplit().responsible })
            });

            expect(hub.db.table).to.have.length(1);
        });

        it('rejects a quorum of CAPABLE validators that the ranking did not make responsible', async function () {
            // The same count of real signatures over the same real canonical from keys
            // the same capability snapshot holds. Only the deterministic hash ranking
            // separates these two cases, so this is what proves the responsible filter
            // is doing work rather than membership alone carrying the row.
            let hub    = makeHub();
            let mirror = new AttestationResponseMirror(hub);
            stubRequestLookup([localRequest()]);
            await mirror.start();

            await mirror._handleResult({
                type: ATTEST_RESULT,
                data: gossipPayload({ signWith: responsibleSplit().outsiders })
            });

            expect(hub.db.table).to.have.length(0);
            expect(mirror.stats.rejected).to.equal(1);
        });

        it('drops a row whose responsible-set signatures do not verify, and writes nothing', async function () {
            let hub    = makeHub();
            let mirror = new AttestationResponseMirror(hub);
            stubRequestLookup([localRequest()]);
            await mirror.start();

            // Real keys, real Ed25519, over the WRONG canonical: a one-second drift in
            // the signed effective_time, which is exactly the field the applying block
            // is a pure function of.
            let payload = gossipPayload({ signCanonical: canonicalFor({ effectiveTime: EFFECTIVE_TIME + 1 }) });
            await mirror._handleResult({ type: ATTEST_RESULT, data: payload });

            expect(hub.db.table).to.have.length(0);
            expect(hub.db.inserts()).to.have.length(0);
            expect(hub.hubDbBroadcaster.broadcastRow.callCount).to.equal(0);
            expect(mirror.stats.rejected).to.equal(1);
        });

        it('drops a row signed by keys outside the capability snapshot', async function () {
            let hub    = makeHub();
            let mirror = new AttestationResponseMirror(hub);
            // The snapshot holds nobody this row was signed by.
            hub.capabilitySnapshot.getWeightSnapshot.resolves({
                validators: [{ pubkey: 'ab'.repeat(32), source: 'other', weight: '100000' }]
            });
            stubRequestLookup([localRequest()]);
            await mirror.start();

            await mirror._handleResult({ type: ATTEST_RESULT, data: gossipPayload() });

            expect(hub.db.table).to.have.length(0);
        });

        it('drops a row whose body does not reproduce the signed hash', async function () {
            let hub    = makeHub();
            let mirror = new AttestationResponseMirror(hub);
            stubRequestLookup([localRequest()]);
            await mirror.start();

            let payload = gossipPayload();
            payload.response_payload = 'a different body';
            await mirror._handleResult({ type: ATTEST_RESULT, data: payload });

            expect(hub.db.table).to.have.length(0);
        });

        it('drops a row for a request BELOW the activation height', async function () {
            // testnet's activation entry is the unratified null sentinel, so no height
            // is mirror-era there: the identical gate the producer path applies.
            let hub    = makeHub({ network: 'testnet' });
            let mirror = new AttestationResponseMirror(hub);
            stubRequestLookup([localRequest({ block_index: 999999 })]);
            await mirror.start();

            await mirror._handleResult({
                type: ATTEST_RESULT,
                data: gossipPayload({ network: 'testnet', requestBlock: 999999 })
            });

            expect(hub.db.table).to.have.length(0);
            expect(mirror.stats.rejected).to.equal(1);
        });

        it('drops a row for another network before it costs a single lookup', async function () {
            let hub    = makeHub();
            let mirror = new AttestationResponseMirror(hub);
            let post   = stubRequestLookup([localRequest()]);
            await mirror.start();

            await mirror._handleResult({ type: ATTEST_RESULT, data: gossipPayload({ network: 'testnet' }) });

            expect(hub.db.table).to.have.length(0);
            expect(post.callCount).to.equal(0);
        });

        it('is a no-op on a row this hub already holds, and spends no indexer lookup on it', async function () {
            let hub    = makeHub();
            let mirror = new AttestationResponseMirror(hub);
            let post   = stubRequestLookup([localRequest()]);
            await mirror.start();

            await mirror._handleResult({ type: ATTEST_RESULT, data: gossipPayload() });
            expect(hub.db.table).to.have.length(1);
            let lookupsAfterFirst = post.callCount;

            await mirror._handleResult({ type: ATTEST_RESULT, data: gossipPayload() });

            expect(hub.db.table).to.have.length(1);
            expect(hub.db.inserts()).to.have.length(1);
            expect(hub.hubDbBroadcaster.broadcastRow.callCount).to.equal(1);
            expect(hub.peerManager.broadcast.callCount).to.equal(0);
            expect(post.callCount).to.equal(lookupsAfterFirst);
            expect(mirror.stats.duplicates).to.equal(1);
        });

        it('ignores an envelope of any other type', async function () {
            let hub    = makeHub();
            let mirror = new AttestationResponseMirror(hub);
            stubRequestLookup([localRequest()]);
            await mirror.start();

            hub.peerManager.emit('message', { type: 'XANCREWARD', data: gossipPayload() });
            await settle();

            expect(hub.db.table).to.have.length(0);
            expect(mirror.stats.received).to.equal(0);
        });

        it('is driven by the PeerManager message subscription, not only by direct calls', async function () {
            let hub    = makeHub();
            let mirror = new AttestationResponseMirror(hub);
            stubRequestLookup([localRequest()]);
            await mirror.start();

            hub.peerManager.emit('message', { type: ATTEST_RESULT, data: gossipPayload() });
            await settle();
            await settle();

            expect(hub.db.table).to.have.length(1);
        });

        it('detaches the peer subscription in stop()', async function () {
            let hub    = makeHub();
            let mirror = new AttestationResponseMirror(hub);
            await mirror.start();
            expect(hub.peerManager.listenerCount('message')).to.equal(1);
            await mirror.stop();
            expect(hub.peerManager.listenerCount('message')).to.equal(0);
        });
    });

    // ── park one cycle, retry once, then drop ───────────────────────────────

    describe('an unknown request', function () {

        it('parks the row instead of writing or dropping it', async function () {
            let hub    = makeHub();
            let mirror = new AttestationResponseMirror(hub);
            stubRequestLookup([]);                       // the v0 is not indexed yet
            await mirror.start();

            await mirror._handleResult({ type: ATTEST_RESULT, data: gossipPayload() });

            expect(hub.db.table).to.have.length(0);
            expect(mirror._parked.size).to.equal(1);
            expect(mirror.stats.parked).to.equal(1);
            expect(mirror.stats.dropped).to.equal(0);
        });

        it('applies the row when the retry cycle finds the request', async function () {
            let hub    = makeHub();
            let mirror = new AttestationResponseMirror(hub);
            let post   = stubRequestLookup([]);
            await mirror.start();

            await mirror._handleResult({ type: ATTEST_RESULT, data: gossipPayload() });
            expect(mirror._parked.size).to.equal(1);

            // The indexer catches up between cycles.
            post.resolves({ data: { result: { latest_block_index: LATEST_BLOCK, count: 1, requests: [localRequest()] } } });
            await mirror._drainParked();

            expect(hub.db.table).to.have.length(1);
            expect(mirror._parked.size).to.equal(0);
        });

        it('drops the row after exactly one retry, and never re-parks it', async function () {
            let hub    = makeHub();
            let mirror = new AttestationResponseMirror(hub);
            stubRequestLookup([]);
            await mirror.start();

            await mirror._handleResult({ type: ATTEST_RESULT, data: gossipPayload() });
            await mirror._drainParked();

            expect(hub.db.table).to.have.length(0);
            expect(mirror._parked.size).to.equal(0);
            expect(mirror.stats.dropped).to.equal(1);

            // A second cycle has nothing left to do: the row is gone, not re-parked.
            await mirror._drainParked();
            expect(mirror.stats.dropped).to.equal(1);
        });

        it('buys one retry per logical row however many peers gossip it', async function () {
            let hub    = makeHub();
            let mirror = new AttestationResponseMirror(hub);
            stubRequestLookup([]);
            await mirror.start();

            await mirror._handleResult({ type: ATTEST_RESULT, data: gossipPayload() });
            await mirror._handleResult({ type: ATTEST_RESULT, data: gossipPayload() });
            await mirror._handleResult({ type: ATTEST_RESULT, data: gossipPayload() });

            expect(mirror._parked.size).to.equal(1);
            expect(mirror.stats.parked).to.equal(1);
        });

        it('bounds the park set and evicts the oldest entry first', async function () {
            let hub    = makeHub();
            let mirror = new AttestationResponseMirror(hub);
            stubRequestLookup([]);
            await mirror.start();

            let firstRid = null;
            for(let i = 0; i < PARK_MAX + 5; i++){
                let rid = crypto.createHash('sha256').update('rid' + i).digest('hex');
                if(i === 0) firstRid = rid;
                await mirror._handleResult({
                    type: ATTEST_RESULT,
                    data: gossipPayload({ requestId: rid, signCanonical: canonicalFor({ requestId: rid }) })
                });
            }

            expect(mirror._parked.size).to.equal(PARK_MAX);
            expect(mirror._parked.has('regtest|' + firstRid)).to.equal(false);
            expect(mirror.stats.dropped).to.equal(5);
        });

        it('parks rather than drops when the local indexer cannot be reached at all', async function () {
            let hub    = makeHub();
            let mirror = new AttestationResponseMirror(hub);
            sinon.stub(axios, 'post').rejects(new Error('ECONNREFUSED'));
            await mirror.start();

            await mirror._handleResult({ type: ATTEST_RESULT, data: gossipPayload() });

            expect(mirror._parked.size).to.equal(1);
            expect(hub.db.table).to.have.length(0);
        });
    });

    // ── structural rejection, before anything is spent ───────────────────────

    describe('a malformed payload', function () {

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

        Object.keys(CASES).forEach(name => {
            it('rejects ' + name + ' without any indexer lookup', async function () {
                let hub    = makeHub();
                let mirror = new AttestationResponseMirror(hub);
                let post   = stubRequestLookup([localRequest()]);
                await mirror.start();

                await mirror._handleResult({ type: ATTEST_RESULT, data: Object.assign(gossipPayload(), CASES[name]) });

                expect(hub.db.table).to.have.length(0);
                expect(post.callCount).to.equal(0);
                expect(mirror.stats.rejected).to.equal(1);
            });
        });
    });
});
