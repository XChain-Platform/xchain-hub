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

// AT2 for the proactive-system-watch spec: the PBFT paths that drop a message
// with a bare `return` now say so. Each case drives the REAL handler rather
// than calling noteDrop directly, because the claim under test is that the
// drop site is wired, not that the emitter works.

const sinon             = require('sinon');
const { expect }        = require('chai');
const OracleConsensus   = require('../../src/OracleConsensus');
const { createMockHub } = require('../helpers/mockHub');
const { pubkeyForTestSender } = require('../helpers/fixtures');
const diagnostics       = require('../../src/consensusDiagnostics');
const observability     = require('../../src/observability');

describe('consensus diagnostics: silent PBFT drops become records (AT2)', function () {

    let hub, oc, oracleRound, sink;

    const VALSET = [
        { addr: 'ws://val-a:10001', pubkey: 'a1'.repeat(32) },
        { addr: 'ws://val-b:10002', pubkey: 'b2'.repeat(32) },
        { addr: 'ws://val-c:10003', pubkey: 'c3'.repeat(32) },
    ];
    const ROUND  = 300;   // round % 3 === 0 -> leader is VALSET[0]
    const PRICES = [{ coinPair: 'BTC/USD', price: '100.00000000' }];

    function proposeEnvelope(digest) {
        return {
            type: 'ORACLE_PROPOSE', sender: VALSET[0].addr, sig_pubkey: VALSET[0].pubkey,
            data: { round: ROUND, prices: PRICES, digest, btcBlockHeight: 1000, btcBlockTime: 1700000000 }
        };
    }
    function voteEnvelope(type, sender, digest) {
        const v = VALSET.find(x => x.addr === sender);
        return {
            type, sender, sig_pubkey: v ? v.pubkey : pubkeyForTestSender(sender),
            data: { round: ROUND, digest }
        };
    }

    // Records, not printed lines: getLogger() routes to whatever shipper the
    // process installed, so a capture sink on that shipper sees the fields.
    function drops(reason) {
        return sink.lines.filter(l => l.includes('PBFT_DROP') && (!reason || l.includes(`reason=${reason}`)));
    }
    function counterValue(reason, phase) {
        const line = observability.getRegistry().render().split('\n')
            .find(l => l.startsWith(`xchain_pbft_drops_total{reason="${reason}",phase="${phase}"}`));
        return line ? Number(line.trim().split(' ').pop()) : 0;
    }

    beforeEach(function () {
        observability._resetObservability();
        diagnostics._resetDiagnostics();
        sink = { lines: [] };
        const push = (m) => sink.lines.push(m);
        observability.installObservability(null, {
            service: 'xchain-hub', env: {}, console: { log: push, warn: push, error: push }
        });

        hub = createMockHub({ validatorAddr: VALSET[1].addr });   // we are val-b, a follower
        // A real federated hub always resolves a BTC tip of its own, and the follower
        // now bounds the leader-stamped btcBlockHeight against it, so the fixture has
        // to model one. Same height the PROPOSE carries: an honest round in lockstep.
        hub._resolveBtcLatestBlock = sinon.stub().resolves(1000);
        oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
        oc = new OracleConsensus(hub, oracleRound);
        oc.setValidatorSet(VALSET);
        oc._lastFinalizedPrices = new Map([['BTC/USD', '100.00000000']]);
    });

    afterEach(function () {
        oc.stop();
        sinon.restore();
        observability._resetObservability();
        diagnostics._resetDiagnostics();
    });

    it('records a PREPARE whose digest disagrees with the pending round', async function () {
        const digest = oc._digest(ROUND, PRICES);
        await oc._handlePropose(proposeEnvelope(digest));
        expect(oc.pendingRounds.has(ROUND)).to.equal(true);

        oc._handlePrepare(voteEnvelope('ORACLE_PREPARE', VALSET[2].addr, 'f'.repeat(64)));

        expect(drops('digest_mismatch')).to.have.lengthOf(1);
        expect(drops('digest_mismatch')[0]).to.include('phase=prepare');
        expect(counterValue('digest_mismatch', 'prepare')).to.equal(1);
    });

    it('records a COMMIT whose digest disagrees with the pending round', async function () {
        const digest = oc._digest(ROUND, PRICES);
        await oc._handlePropose(proposeEnvelope(digest));
        oc._handleCommit(voteEnvelope('ORACLE_COMMIT', VALSET[2].addr, 'e'.repeat(64)));
        expect(counterValue('digest_mismatch', 'commit')).to.equal(1);
    });

    it('records a vote from a sender the registry does not attribute', function () {
        // An EMPTY registry is deliberately lenient (chain_signer_admission rule
        // 2), so the unknown-sender path only exists once the hub actually has
        // an authorization floor loaded. Populate it, then sign as an outsider.
        hub._peerManager.validatorPubkeys = new Map(VALSET.map(v => [v.addr, v.pubkey]));

        oc._handlePrepare(voteEnvelope('ORACLE_PREPARE', 'ws://stranger:1', 'a'.repeat(64)));

        expect(drops('unknown_sender')).to.have.lengthOf(1);
        expect(counterValue('unknown_sender', 'prepare')).to.equal(1);
    });

    it('records an early-buffer entry that ages out unread, with how many votes were lost', function () {
        const digest = oc._digest(ROUND, PRICES);
        oc._handlePrepare(voteEnvelope('ORACLE_PREPARE', VALSET[2].addr, digest));
        expect(oc.earlyMessages.get(ROUND)).to.have.length(1);

        // A round that assembles drains its buffer, so anything still parked at
        // expiry is a vote that was silently lost.
        oc._pruneEarlyMessages(Date.now() + oc.earlyMessageTtlMs + 1);

        expect(drops('early_ttl')).to.have.lengthOf(1);
        expect(drops('early_ttl')[0]).to.include('count=1');
        expect(oc.earlyMessages.has(ROUND)).to.equal(false);
        expect(counterValue('early_ttl', 'buffer')).to.equal(1);
    });

    it('records the per-round buffer ceiling turning votes away', function () {
        const digest = oc._digest(ROUND, PRICES);
        for (let i = 0; i < oc.earlyMessageMaxPerRound + 3; i++) {
            oc._handlePrepare(voteEnvelope('ORACLE_PREPARE', 'ws://flood-' + i + ':1', digest));
        }
        expect(oc.earlyMessages.get(ROUND)).to.have.length(oc.earlyMessageMaxPerRound);
        expect(drops('early_capacity')).to.have.lengthOf(3);
        expect(counterValue('early_capacity', 'buffer')).to.equal(3);
    });

    it('gives the three AT2 reasons distinct records and distinct counter series', async function () {
        hub._peerManager.validatorPubkeys = new Map(VALSET.map(v => [v.addr, v.pubkey]));
        const digest = oc._digest(ROUND, PRICES);
        await oc._handlePropose(proposeEnvelope(digest));

        oc._handlePrepare(voteEnvelope('ORACLE_PREPARE', VALSET[2].addr, 'f'.repeat(64)));   // digest_mismatch
        oc._handlePrepare(voteEnvelope('ORACLE_PREPARE', 'ws://stranger:1', digest));        // unknown_sender
        oc.earlyMessages.set(999, [voteEnvelope('ORACLE_PREPARE', VALSET[2].addr, digest)]);
        oc.earlyMessageTtl.set(999, Date.now() - 1);
        oc._pruneEarlyMessages(Date.now());                                                  // early_ttl

        const reasons = new Set(drops().map(l => (l.match(/reason=(\w+)/) || [])[1]));
        expect([...reasons].sort()).to.deep.equal(['digest_mismatch', 'early_ttl', 'unknown_sender']);
        expect(counterValue('digest_mismatch', 'prepare')).to.equal(1);
        expect(counterValue('unknown_sender', 'prepare')).to.equal(1);
        expect(counterValue('early_ttl', 'buffer')).to.equal(1);
    });
});

describe('consensus diagnostics: unknown-sender throttling', function () {
    const { noteDrop, stampRemoteIp, remoteIpOf, DEDUPE_MAX_KEYS, REMOTE_IP } = diagnostics;
    let sink;

    beforeEach(function () {
        observability._resetObservability();
        diagnostics._resetDiagnostics();
        sink = { lines: [] };
        const push = (m) => sink.lines.push(m);
        observability.installObservability(null, {
            service: 'xchain-hub', env: {}, console: { log: push, warn: push, error: push }
        });
    });
    afterEach(function () {
        observability._resetObservability();
        diagnostics._resetDiagnostics();
    });

    it('throttles a flood from one IP to one line while still counting every drop', function () {
        const env = stampRemoteIp({ sender: 'ws://x:1' }, '203.0.113.9');
        for (let i = 0; i < 50; i++) noteDrop({ reason: 'unknown_sender', phase: 'prepare', envelope: env });

        const lines = sink.lines.filter(l => l.includes('PBFT_DROP'));
        expect(lines).to.have.lengthOf(1);
        const rendered = observability.getRegistry().render();
        expect(rendered).to.include('xchain_pbft_drops_total{reason="unknown_sender",phase="prepare"} 50');
    });

    it('keys the throttle on the transport IP, not on the attacker-supplied sender', function () {
        // Keying on envelope.sender would let one connection rotate the field and
        // mint a fresh bucket per message, so the ceiling would never engage.
        for (let i = 0; i < 20; i++) {
            const env = stampRemoteIp({ sender: 'ws://rotating-' + i + ':1' }, '203.0.113.9');
            noteDrop({ reason: 'unknown_sender', phase: 'prepare', envelope: env });
        }
        expect(sink.lines.filter(l => l.includes('PBFT_DROP'))).to.have.lengthOf(1);
    });

    it('separates distinct IPs, and reports how many it suppressed', function () {
        const a = stampRemoteIp({ sender: 'ws://x:1' }, '203.0.113.1');
        const b = stampRemoteIp({ sender: 'ws://y:1' }, '203.0.113.2');
        noteDrop({ reason: 'unknown_sender', phase: 'prepare', envelope: a });
        noteDrop({ reason: 'unknown_sender', phase: 'prepare', envelope: b });
        expect(sink.lines.filter(l => l.includes('PBFT_DROP'))).to.have.lengthOf(2);
        expect(sink.lines.some(l => l.includes('peer_ip=203.0.113.1'))).to.equal(true);
        expect(sink.lines.some(l => l.includes('peer_ip=203.0.113.2'))).to.equal(true);
    });

    it('bounds the dedupe table and counts what it evicts', function () {
        for (let i = 0; i < DEDUPE_MAX_KEYS + 25; i++) {
            const env = stampRemoteIp({ sender: 'ws://x:1' }, '198.51.100.' + i);
            noteDrop({ reason: 'unknown_sender', phase: 'prepare', envelope: env });
        }
        const rendered = observability.getRegistry().render();
        const evicted = Number((rendered.split('\n')
            .find(l => l.startsWith('xchain_pbft_drop_dedupe_evictions_total')) || '0 0').trim().split(' ').pop());
        expect(evicted).to.be.greaterThan(0);
    });

    it('never lets the stamped IP reach a serialized envelope', function () {
        // The stamp is a non-enumerable Symbol key precisely so it cannot ride
        // into a persisted row, a re-broadcast payload or a signature preimage.
        const env = stampRemoteIp({ sender: 'ws://x:1', data: { round: 1 } }, '203.0.113.9');
        expect(JSON.stringify(env)).to.not.include('203.0.113.9');
        expect(Object.keys(env)).to.deep.equal(['sender', 'data']);
        expect(remoteIpOf(env)).to.equal('203.0.113.9');
        expect(env[REMOTE_IP]).to.equal('203.0.113.9');
    });

    it('reports an unstamped envelope as unknown rather than throwing', function () {
        expect(() => noteDrop({ reason: 'unknown_sender', phase: 'prepare', envelope: {} })).to.not.throw();
        expect(sink.lines.some(l => l.includes('peer_ip=unknown'))).to.equal(true);
    });

    it('maps an unrecognised reason to unknown_reason instead of minting a series', function () {
        noteDrop({ reason: 'not_a_real_reason', phase: 'prepare' });
        expect(observability.getRegistry().render()).to.include('reason="unknown_reason"');
    });
});

describe('consensus diagnostics: checkpoint cadence stalls', function () {
    let sink;
    beforeEach(function () {
        observability._resetObservability();
        diagnostics._resetDiagnostics();
        sink = { lines: [] };
        const push = (m) => sink.lines.push(m);
        observability.installObservability(null, {
            service: 'xchain-hub', env: {}, console: { log: push, warn: push, error: push }
        });
    });
    afterEach(function () {
        observability._resetObservability();
        diagnostics._resetDiagnostics();
    });

    it('records every stalled tick, not one in sixty', function () {
        // The prose line beside this is throttled so a persistent stall does not
        // flood an operator's tail. The record must NOT share that throttle: a
        // collector counting stalled ticks needs every one, and dropping 59 of
        // every 60 makes a worsening cadence read as a steady one.
        const StateCheckpointEngine = require('../../src/StateCheckpointEngine');
        const engine = Object.create(StateCheckpointEngine.prototype);
        engine._cadenceStalls = 0;
        engine._cadenceStallLoggedAt = Date.now();   // throttle CLOSED
        engine._cadenceStallLogMs = 600000;
        engine.chains = ['BTC', 'LTC', 'DOGE'];

        for (let i = 0; i < 5; i++) engine._noteCadenceStall(100 + i, 'no qualified oracle_publish validator set');

        const records = sink.lines.filter((l) => l.includes('CHECKPOINT_STALLED'));
        expect(records).to.have.lengthOf(5);
        expect(records[0]).to.include('chains=BTC/LTC/DOGE');
        expect(records[0]).to.include('reason="no qualified oracle_publish validator set"');
        expect(records[4]).to.include('stalls=5');
    });

    it('carries the block it could not lead, and says unknown rather than dropping the field', function () {
        const StateCheckpointEngine = require('../../src/StateCheckpointEngine');
        const engine = Object.create(StateCheckpointEngine.prototype);
        engine._cadenceStalls = 0;
        engine._cadenceStallLoggedAt = Date.now();
        engine._cadenceStallLogMs = 600000;

        engine._noteCadenceStall(null, 'no snapshot rows');
        const rec = sink.lines.find((l) => l.includes('CHECKPOINT_STALLED'));
        expect(rec).to.include('reason="no snapshot rows"');
        expect(rec).to.not.include('block=');
        expect(rec).to.not.include('seq=');
    });

    it('names the round chains it actually runs, never a hardcoded BTC', function () {
        // The emission read `this.coin`, a property this class never assigns, so the
        // `|| 'BTC'` fallback fired every time and an LTC/DOGE hub's stall read as BTC.
        const StateCheckpointEngine = require('../../src/StateCheckpointEngine');
        const engine = Object.create(StateCheckpointEngine.prototype);
        engine._cadenceStalls = 0;
        engine._cadenceStallLoggedAt = Date.now();
        engine._cadenceStallLogMs = 600000;
        engine.chains = ['LTC', 'DOGE'];

        engine._noteCadenceStall(4855000, 'no validator identity (cannot sign checkpoints)');

        const rec = sink.lines.find((l) => l.includes('CHECKPOINT_STALLED'));
        expect(rec).to.include('chains=LTC/DOGE');
        expect(rec).to.include('block=4855000');
        expect(rec).to.not.include('BTC');
        expect(rec).to.not.include('seq=');
    });
});
