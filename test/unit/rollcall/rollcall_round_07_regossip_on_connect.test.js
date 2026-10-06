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
// A peer link that reconnects while both hubs keep running must receive the
// signatures this hub holds for every round still inside the accept window.
// Regtest constants: interval 30, accept window 12.

const sinon        = require('sinon');
const assert       = require('assert');
const fs           = require('fs');
const os           = require('os');
const path         = require('path');
const EventEmitter = require('events');

const ValidatorIdentity = require('../../../src/validators/identity.js');
const rca               = require('../../../src/consensus/gates/rollcall_gate.js');
const RollcallRound     = require('../../../src/rollcall/round.js');
const { XROLLCALL_SIGN } = RollcallRound;

const EPOCH     = 30;
const CANONICAL = 'regossip-test-canonical';
const IDS = ['11', '22', '33'].map(s => new ValidatorIdentity(s.repeat(32)));
const PKS = IDS.map(i => i.getPubkeyHex().toLowerCase());
const SIGS = IDS.map(i => i.sign(CANONICAL));

const ENV_KEYS = ['ROLLCALL_ENABLED', 'ROLLCALL_SIGN_LOG_PATH', 'ROLLCALL_SPEND_LOG_PATH',
                  'ROLLCALL_SPEND_STATE_PATH', 'BTC_INDEXER_URL'];

function makeEngine() {
    const pm = new EventEmitter();
    pm.broadcast  = sinon.stub();
    pm.sendToPeer = sinon.stub().returns(true);
    const eng = new RollcallRound({ network: 'regtest', peerManager: pm, identity: IDS[0],
                                    capabilitySnapshot: null, p2pConfig: {} });
    return { eng, pm };
}

function openRound(eng, epoch, count) {
    const sigs = new Map();
    for (let i = 0; i < count; i++) sigs.set(PKS[i], SIGS[i]);
    eng.rounds.set(epoch, { epoch, canonical: CANONICAL, members: new Set(PKS), sigs, txids: [] });
}

const ctx = { engines: [], tmpDir: null, savedEnv: null, savedActivation: null };

async function started() {
    const made = makeEngine();
    ctx.engines.push(made.eng);
    await made.eng.start();
    return made;
}

function assertFullReplay(pm, addr) {
    assert.strictEqual(pm.sendToPeer.callCount, 3);
    const sent = pm.sendToPeer.getCalls().map(c => {
        assert.strictEqual(c.args[0], addr);
        assert.strictEqual(c.args[1], XROLLCALL_SIGN);
        return c.args[2];
    });
    assert.deepStrictEqual(sent.map(d => d.pubkey).sort(), PKS.slice().sort());
    for (const d of sent) {
        assert.strictEqual(d.epoch, EPOCH);
        assert.strictEqual(d.sig, SIGS[PKS.indexOf(d.pubkey)]);
    }
}

function installHooks() {
    before(function () {
        ctx.savedActivation = rca.ROLLCALL_ACTIVATION.regtest;
        rca.ROLLCALL_ACTIVATION.regtest = 0;
    });
    after(function () { rca.ROLLCALL_ACTIVATION.regtest = ctx.savedActivation; });

    beforeEach(function () {
        ctx.engines = [];
        ctx.savedEnv = {};
        for (const k of ENV_KEYS) { ctx.savedEnv[k] = process.env[k]; delete process.env[k]; }
        ctx.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollcall-regossip-'));
        process.env.ROLLCALL_SIGN_LOG_PATH    = path.join(ctx.tmpDir, 'sign.jsonl');
        process.env.ROLLCALL_SPEND_LOG_PATH   = path.join(ctx.tmpDir, 'spend.jsonl');
        process.env.ROLLCALL_SPEND_STATE_PATH = path.join(ctx.tmpDir, 'guard.json');
    });

    afterEach(async function () {
        for (const e of ctx.engines) await e.stop();
        sinon.restore();
        for (const k of ENV_KEYS) {
            if (ctx.savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = ctx.savedEnv[k];
        }
        fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
    });
}

describe('RollcallRound push on peer connect', function () {
    installHooks();

    it('sends every held pair of an in-window round to the connecting address', async function () {
        const { eng, pm } = await started();
        openRound(eng, EPOCH, 3);
        eng.lastTip = EPOCH + 6;
        pm.emit('peer:connect', 'peer-a');
        assertFullReplay(pm, 'peer-a');
    });

    it('sends nothing for a round past the accept window', async function () {
        const { eng, pm } = await started();
        openRound(eng, EPOCH, 3);
        eng.lastTip = EPOCH + eng.acceptWindow + 1;
        pm.emit('peer:connect', 'peer-a');
        assert.strictEqual(pm.sendToPeer.callCount, 0);
    });

    it('sends nothing with no open round', async function () {
        const { eng, pm } = await started();
        eng.lastTip = EPOCH + 6;
        pm.emit('peer:connect', 'peer-a');
        assert.strictEqual(pm.sendToPeer.callCount, 0);
    });

    it('does nothing when the peer manager has no sendToPeer', async function () {
        const { eng, pm } = await started();
        openRound(eng, EPOCH, 3);
        eng.lastTip = EPOCH + 6;
        delete pm.sendToPeer;
        assert.doesNotThrow(() => pm.emit('peer:connect', 'peer-a'));
    });

    it('sends nothing after stop()', async function () {
        const { eng, pm } = await started();
        openRound(eng, EPOCH, 3);
        eng.lastTip = EPOCH + 6;
        await eng.stop();
        assert.strictEqual(pm.listenerCount('peer:connect'), 0);
        pm.emit('peer:connect', 'peer-a');
        assert.strictEqual(pm.sendToPeer.callCount, 0);
    });

    it('a second instance fed the sent messages reaches gossiped_count 3', async function () {
        const { eng, pm } = await started();
        openRound(eng, EPOCH, 3);
        eng.lastTip = EPOCH + 6;
        pm.emit('peer:connect', 'peer-a');

        const other = makeEngine().eng;
        other.rounds.set(EPOCH, { epoch: EPOCH, canonical: CANONICAL, members: new Set(PKS), sigs: new Map(), txids: [] });
        for (const c of pm.sendToPeer.getCalls()) other.handleMessage({ type: c.args[1], data: c.args[2] });
        assert.strictEqual(other.getStatus().gossiped_count, 3);
    });
});
