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
// A hub that restarts inside the accept window pulls the open epoch's
// signatures from its peers. Three real RollcallRound engines share an
// in-memory peer bus; signatures are real Ed25519.

const sinon      = require('sinon');
const assert     = require('assert');
const fs         = require('fs');
const os         = require('os');
const path       = require('path');
const proxyquire = require('proxyquire');

const ValidatorIdentity = require('../../../src/validators/identity.js');
const rca               = require('../../../src/consensus/gates/rollcall_gate.js');

const BTC_URL     = 'http://btc-indexer.test';
const LEDGER_HASH = '4a7f1e93c25b8d0617ae42f9308c5b7de1409263a8f5c07be3d4192c6f8ab5e1';
const EPOCH       = 30;
const IDS = ['11', '22', '33'].map(s => new ValidatorIdentity(s.repeat(32)));
const PKS = IDS.map(i => i.getPubkeyHex().toLowerCase());
const ADDRS = ['hub-a', 'hub-b', 'hub-c'];

const ENV_KEYS = ['ROLLCALL_ENABLED', 'ROLLCALL_SPEND_LOG_PATH', 'ROLLCALL_SIGN_LOG_PATH',
                  'ROLLCALL_SPEND_STATE_PATH', 'BTC_INDEXER_URL'];

let RollcallRound, axiosStub, tmpDir, savedEnv, savedActivation, clock;

// An in-memory bus. Each node's peerManager stamps `sender` and delivers to the
// others' 'message' listeners; sendToPeer reaches only a node registered under
// that key unless `directKeys` is false, which models a peer map that does not
// know the envelope sender.
class Bus {
    constructor(){ this.nodes = new Map(); this.log = []; }
    attach(addr, directKeys){
        const listeners = new Set();
        const bus = this;
        const pm = {
            listeners, addr,
            on(ev, fn){ if(ev === 'message') listeners.add(fn); },
            removeListener(ev, fn){ listeners.delete(fn); },
            broadcast: sinon.spy(function(type, data){
                bus.log.push({ via: 'broadcast', from: addr, type, data });
                for(const [a, n] of bus.nodes) if(a !== addr) for(const fn of n.listeners) fn({ type, data, sender: addr });
                return true;
            }),
            sendToPeer: sinon.spy(function(to, type, data){
                bus.log.push({ via: 'direct', from: addr, to, type, data });
                if(!directKeys) return false;
                const n = bus.nodes.get(to);
                if(!n) return false;
                for(const fn of n.listeners) fn({ type, data, sender: addr });
                return true;
            })
        };
        this.nodes.set(addr, pm);
        return pm;
    }
}

function makeEngine(bus, i, directKeys){
    const pm = bus.attach(ADDRS[i], directKeys);
    const hub = {
        network: 'regtest',
        peerManager: pm,
        identity: IDS[i],
        capabilitySnapshot: {
            getActiveWeightSnapshot: sinon.stub().resolves({ validators: PKS.map(pk => ({ pubkey: pk, source: 's', weight: '1000' })) }),
            getWeightSnapshot: sinon.stub().resolves({ validators: PKS.map(pk => ({ pubkey: pk, source: 's', weight: '1000' })) })
        },
        oraclePublisher: null,
        stateAnchorPublisher: null,
        p2pConfig: {},
        resolveBtcIndexerUrl: async () => BTC_URL,
        btcIndexerHeaders: () => ({ 'Content-Type': 'application/json' })
    };
    const eng = new RollcallRound(hub);
    eng.pm = pm;
    pm.on('message', eng._handler);
    return eng;
}

function syncRequests(bus){ return bus.log.filter(e => e.type === 'XROLLCALL_SYNC'); }
function signsTo(bus, from, to){ return bus.log.filter(e => e.type === 'XROLLCALL_SIGN' && e.from === from && e.to === to); }

// Three hubs open the epoch and converge, then hub 0 is replaced by a fresh
// instance with the same identity (a restart that kept only its own signature).
async function converged(directKeys){
    const bus = new Bus();
    const engs = [0, 1, 2].map(i => makeEngine(bus, i, directKeys));
    for(const e of engs) await e.tick();
    for(const e of engs) assert.strictEqual(e.getStatus().gossiped_count, 3);
    bus.log.length = 0;
    engs[0]._handler && bus.nodes.get(ADDRS[0]).listeners.clear();
    const fresh = makeEngine(bus, 0, directKeys);
    return { bus, engs, fresh };
}

describe('RollcallRound resync on open', function(){
    before(function(){
        savedActivation = rca.ROLLCALL_ACTIVATION.regtest;
        rca.ROLLCALL_ACTIVATION.regtest = 0;
    });
    after(function(){ rca.ROLLCALL_ACTIVATION.regtest = savedActivation; });

    beforeEach(function(){
        savedEnv = {};
        for(const k of ENV_KEYS) savedEnv[k] = process.env[k];
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollcall-resync-'));
        process.env.BTC_INDEXER_URL = BTC_URL;
        process.env.ROLLCALL_SPEND_LOG_PATH   = path.join(tmpDir, 'spend.jsonl');
        process.env.ROLLCALL_SIGN_LOG_PATH    = path.join(tmpDir, 'sign.jsonl');
        process.env.ROLLCALL_SPEND_STATE_PATH = path.join(tmpDir, 'guard.json');
        axiosStub = { post: sinon.stub() };
        axiosStub.post.callsFake(async (url, body) => {
            const bi = (body.params && body.params.block_index !== undefined) ? body.params.block_index : 36;
            return { data: { result: { block_index: bi, ledger_hash: LEDGER_HASH } } };
        });
        RollcallRound = proxyquire('../../../src/rollcall/round.js', { axios: axiosStub });
        clock = sinon.useFakeTimers({ now: 1000000, toFake: ['Date'] });
    });
    afterEach(function(){
        clock.restore();
        sinon.restore();
        for(const k of ENV_KEYS){
            if(savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
        }
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_){}
    });

    it('a restarted hub regains every peer signature for the open epoch', async function(){
        const { bus, engs, fresh } = await converged(true);
        await fresh.tick();
        assert.strictEqual(fresh.getStatus().gossiped_count, 3);
        assert.strictEqual(syncRequests(bus).length, 1);
        assert.deepStrictEqual(syncRequests(bus)[0].data, { epoch: EPOCH });
        for(const i of [1, 2]){
            const sent = signsTo(bus, ADDRS[i], ADDRS[0]);
            assert.strictEqual(sent.length, engs[i].rounds.get(EPOCH).sigs.size, 'one SIGN per held pair');
            assert.strictEqual(new Set(sent.map(s => s.data.pubkey)).size, 3);
            assert.ok(engs[i].pm.sendToPeer.returned(true), 'the direct send reached the sender key');
        }
    });

    it('answers by broadcast when sendToPeer does not know the sender', async function(){
        const { bus, fresh } = await converged(false);
        await fresh.tick();
        assert.strictEqual(fresh.getStatus().gossiped_count, 3);
        const replies = bus.log.filter(e => e.type === 'XROLLCALL_SIGN' && e.from !== ADDRS[0]);
        assert.ok(replies.length >= 3);
        assert.ok(replies.every(r => r.via !== 'direct' || r.to === ADDRS[0]));
        assert.ok(bus.log.some(e => e.via === 'broadcast' && e.type === 'XROLLCALL_SIGN' && e.from === ADDRS[1]));
    });

    it('does not answer the same sender and epoch twice inside 60 s', async function(){
        const { bus, engs } = await converged(true);
        const req = { type: 'XROLLCALL_SYNC', data: { epoch: EPOCH }, sender: 'hub-x' };
        engs[1].pm.sendToPeer.resetHistory();
        engs[1].handleMessage(req);
        const first = engs[1].pm.sendToPeer.callCount;
        assert.strictEqual(first, 3);
        engs[1].handleMessage(req);
        assert.strictEqual(engs[1].pm.sendToPeer.callCount, first, 'second request inside 60 s is ignored');
        clock.tick(61000);
        engs[1].handleMessage(req);
        assert.strictEqual(engs[1].pm.sendToPeer.callCount, first * 2, 'answered again after the interval');
        assert.ok(bus);
    });

    it('ignores a request with no open round, a bad epoch or no sender', async function(){
        const { engs } = await converged(true);
        const e = engs[1];
        e.pm.sendToPeer.resetHistory();
        e.pm.broadcast.resetHistory();
        e.handleMessage({ type: 'XROLLCALL_SYNC', data: { epoch: 60 }, sender: 'hub-x' });
        e.handleMessage({ type: 'XROLLCALL_SYNC', data: { epoch: 'abc' }, sender: 'hub-x' });
        e.handleMessage({ type: 'XROLLCALL_SYNC', data: { epoch: 30.5 }, sender: 'hub-x' });
        e.handleMessage({ type: 'XROLLCALL_SYNC', data: { epoch: EPOCH } });
        assert.strictEqual(e.pm.sendToPeer.callCount, 0);
        assert.strictEqual(e.pm.broadcast.callCount, 0);
    });

    it('ignores a request once the tip is past the accept window', async function(){
        const { engs } = await converged(true);
        const e = engs[1];
        e.lastTip = EPOCH + e.acceptWindow + 1;
        e.pm.sendToPeer.resetHistory();
        e.handleMessage({ type: 'XROLLCALL_SYNC', data: { epoch: EPOCH }, sender: 'hub-x' });
        assert.strictEqual(e.pm.sendToPeer.callCount, 0);
    });
});
