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

// An observer hub does not send into rounds it cannot sign.
//
// A hub whose signing key is outside the chain-effective signer set has every
// envelope it authors dropped at each peer's _verifySignature, before any
// handler runs. The testnet service hub sat in exactly that state after it was
// re-admitted: five validators logged PEER_REJECT reason=not_in_signer_set once
// every 4 s for hours, and the hub itself recorded CHECKPOINT_STALLED every two
// blocks for a set it could never join. Nothing about that traffic could ever
// land, so the hub now holds back what it authors and keeps mirroring, relaying
// and serving.
//
// The gate has to be one-way: it may only silence a hub whose absence from the
// set is DEFINITE. An unresolved set, an empty one, a missing identity or a mesh
// that does not require signatures all fail open, because a real validator going
// quiet on a transient set read is a liveness fault far worse than the noise.

const sinon                 = require('sinon');
const { expect }            = require('chai');
const PeerManager           = require('../../src/PeerManager');
const ValidatorIdentity     = require('../../src/ValidatorIdentity');
const StateCheckpointEngine = require('../../src/StateCheckpointEngine');

const TIP = {
    block_index: 500, block_hash: 'c0'.repeat(32), network: 'regtest',
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    state_root: 'd4'.repeat(32), state_root_version: 1,
    block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1
};

describe('observer hub does not author into rounds it cannot sign', function () {

    let config, dbStub, pm, me, peer, frames, logs;

    beforeEach(function () {
        me   = ValidatorIdentity.generate();
        peer = ValidatorIdentity.generate();
        config = {
            P2P_VALIDATOR_ADDR: 'ws://self:10002',
            P2P_PORT: 0,
            P2P_HOST: '127.0.0.1',
            SEED_NODES: [],
            REQUIRE_SIGNATURES: true,
            P2P_MSG_DEDUP_TTL: 60000,
            P2P_HEARTBEAT_INTERVAL: 15000
        };
        dbStub = { doQuery: sinon.stub().resolves([]) };
        pm = new PeerManager(config, dbStub);
        pm.setIdentity(new ValidatorIdentity(me.privkeyHex));

        frames = [];
        logs   = [];
        sinon.stub(console, 'log').callsFake((m) => logs.push(String(m)));
    });

    afterEach(function () {
        sinon.restore();
    });

    // One OPEN peer socket, capturing every frame the manager writes to it.
    function attachPeer(addr) {
        let ws = { readyState: 1, send: (s) => frames.push(s), ping() {} };
        pm.peers.set(addr || 'ws://peer:10002', {
            ws: ws, state: 'connected', lastSeen: Date.now(), inbound: false
        });
        return ws;
    }

    function holdLines() {
        return logs.filter(l => l.includes('not in the') && l.includes('chain-effective'));
    }

    function resumeLines() {
        return logs.filter(l => l.includes('authoring consensus messages again'));
    }

    // -----------------------------------------------------------------
    // (1) outside the set: sends nothing, still receives
    // -----------------------------------------------------------------

    describe('a hub outside the resolved signer set', function () {

        beforeEach(function () {
            // The set exists and names someone else. This is the definite absence.
            pm.setEffectiveSignerSet(new Set([peer.pubkeyHex.toLowerCase()]));
        });

        it('writes no frame for anything it authors', function () {
            attachPeer();

            expect(pm.broadcast('PBFT_PRE_PREPARE', { seq: 1 }), 'no envelope is built').to.equal(null);
            expect(pm.broadcast('ORACLE_PROPOSE', { round: 7 })).to.equal(null);
            expect(pm.broadcast('XCHK_SIGN_REQ', { checkpoint: {} })).to.equal(null);
            expect(pm.broadcast('HEARTBEAT', { version: '0.0.0' })).to.equal(null);
            expect(pm.sendToPeer('ws://peer:10002', 'ATTEST_PREPARE', {}), 'the unicast path too').to.equal(false);

            expect(frames, 'nothing reached the wire').to.have.lengthOf(0);
            expect(pm.seenIds.size, 'and no dedup slot was spent on a message nobody sees').to.equal(0);
        });

        it('still verifies and emits an inbound message from a set member', function () {
            let env = {
                id: 'xc2418-in', type: 'ORACLE_PROPOSE', sender: 'ws://peer:10002',
                timestamp: Date.now(), data: { round: 7 }, sig_pubkey: peer.pubkeyHex
            };
            env.sig = new ValidatorIdentity(peer.privkeyHex).signEnvelope(env);

            let emitted = [];
            pm.on('message', (e) => emitted.push(e));
            pm._handleInbound({ _peerAddr: 'ws://peer:10002', _remoteIp: '203.0.113.7' },
                JSON.stringify(env), 'ws://peer:10002');

            expect(emitted, 'receiving is untouched by the hold').to.have.lengthOf(1);
            expect(emitted[0].type).to.equal('ORACLE_PROPOSE');
        });

        it('relays another validator\'s envelope unchanged', function () {
            attachPeer('ws://other:10002');
            let env = {
                id: 'xc2418-relay', type: 'ORACLE_PREPARE', sender: 'ws://peer:10002',
                timestamp: Date.now(), data: { round: 7 }, sig_pubkey: peer.pubkeyHex
            };
            env.sig = new ValidatorIdentity(peer.privkeyHex).signEnvelope(env);

            pm._handleInbound({ _peerAddr: 'ws://peer:10002', _remoteIp: '203.0.113.7' },
                JSON.stringify(env), 'ws://peer:10002');

            expect(frames, 'gossip service continues').to.have.lengthOf(1);
            expect(JSON.parse(frames[0]).sender, 'the original author, not this hub').to.equal('ws://peer:10002');
        });

        it('attempts no checkpoint round and meters no cadence stall', async function () {
            let held = { on() {}, removeListener() {}, broadcast() {}, authoringHeld: () => true };
            let { engine, indexerCalls, db } = buildCheckpointEngine(held);

            await engine._tick();
            await engine._tick();

            expect(indexerCalls, 'not even the tip is fetched').to.have.lengthOf(0);
            expect(db.checkpoints, 'no checkpoint is cut').to.have.lengthOf(0);
            let stats = await engine.getStats();
            expect(stats.cadence_stalls, 'a set it cannot join is not a stall to meter').to.equal(0);
            expect(stats.cadence_stall_reason).to.equal(null);
            expect(stats.observer_idle, 'the idle reason is reported instead').to.equal(true);
        });
    });

    // -----------------------------------------------------------------
    // (2) inside the set: byte-for-byte unchanged
    // -----------------------------------------------------------------

    it('a hub inside the set sends the same bytes it always did', function () {
        let ws = attachPeer();
        pm.setEffectiveSignerSet(new Set([me.pubkeyHex.toLowerCase(), peer.pubkeyHex.toLowerCase()]));

        // Freeze the two fields that are fresh per envelope, so the comparison is
        // over the whole frame rather than a field-by-field paraphrase of it.
        sinon.stub(Date, 'now').returns(1757700000000);
        sinon.stub(pm, '_makeId').returns('xc2418-fixed-id');

        let expected = JSON.stringify(pm._buildEnvelope('ORACLE_PROPOSE', { round: 7, price: '1.25' }));
        let envelope = pm.broadcast('ORACLE_PROPOSE', { round: 7, price: '1.25' });

        expect(envelope, 'the return contract is unchanged for a member').to.be.an('object');
        expect(frames, 'one frame per open peer').to.have.lengthOf(1);
        expect(frames[0], 'byte-for-byte the pre-gate frame').to.equal(expected);
        expect(pm.seenIds.has('xc2418-fixed-id'), 'own message still marked seen').to.equal(true);
        expect(ws.readyState).to.equal(1);
    });

    it('a member hub is announced nowhere: the gate is silent on the normal path', function () {
        attachPeer();
        pm.setEffectiveSignerSet(new Set([me.pubkeyHex.toLowerCase()]));
        pm.broadcast('HEARTBEAT', { version: '0.0.0' });

        expect(holdLines(), 'no hold line').to.have.lengthOf(0);
        expect(resumeLines(), 'and no resume line at boot').to.have.lengthOf(0);
    });

    // -----------------------------------------------------------------
    // (3) fail open: every state that is not a definite absence
    // -----------------------------------------------------------------

    describe('fails open when the set cannot say "absent"', function () {

        it('sends when the signer set has never resolved', function () {
            attachPeer();
            expect(pm.effectiveSignerSet, 'the pre-refresh state').to.equal(null);
            expect(pm.authoringHeld()).to.equal(false);
            pm.broadcast('PBFT_PREPARE', { seq: 1 });
            expect(frames).to.have.lengthOf(1);
        });

        it('sends when the resolved set is empty (boot, or an upstream that answered nothing)', function () {
            attachPeer();
            pm.setEffectiveSignerSet(new Set());
            expect(pm.authoringHeld()).to.equal(false);
            pm.broadcast('PBFT_PREPARE', { seq: 1 });
            expect(frames).to.have.lengthOf(1);
        });

        it('sends when a refresh failure leaves the last good set in place and we are in it', function () {
            attachPeer();
            pm.setEffectiveSignerSet(new Set([me.pubkeyHex.toLowerCase()]));
            pm.broadcast('PBFT_PREPARE', { seq: 1 });
            // The refresh never clears to empty on failure; the stale set still names us.
            pm.broadcast('PBFT_COMMIT', { seq: 1 });
            expect(frames).to.have.lengthOf(2);
        });

        it('sends when the hub carries no identity at all', function () {
            attachPeer();
            pm.setIdentity(null);
            pm.setEffectiveSignerSet(new Set([peer.pubkeyHex.toLowerCase()]));
            expect(pm.authoringHeld()).to.equal(false);
            pm.broadcast('PBFT_PREPARE', { seq: 1 });
            expect(frames).to.have.lengthOf(1);
        });

        it('sends on a mesh that does not require signatures, where peers admit anyone', function () {
            attachPeer();
            pm.requireSigs = false;
            pm.setEffectiveSignerSet(new Set([peer.pubkeyHex.toLowerCase()]));
            expect(pm.authoringHeld()).to.equal(false);
            pm.broadcast('PBFT_PREPARE', { seq: 1 });
            expect(frames).to.have.lengthOf(1);
        });

        it('sends when the identity will not render its pubkey', function () {
            attachPeer();
            pm.setIdentity({ getPubkeyHex() { throw new Error('key unreadable'); } });
            pm.setEffectiveSignerSet(new Set([peer.pubkeyHex.toLowerCase()]));
            expect(pm.authoringHeld(), 'a key we cannot read is not a key we can call absent').to.equal(false);
        });

        it('a checkpoint engine whose peer manager predates the gate keeps its old cadence', async function () {
            let old = { on() {}, removeListener() {}, broadcast() {} };
            let { engine, indexerCalls } = buildCheckpointEngine(old);

            await engine._tick();

            expect(indexerCalls.length, 'the round ran as before').to.be.greaterThan(0);
            expect((await engine.getStats()).observer_idle).to.equal(false);
        });
    });

    // -----------------------------------------------------------------
    // (4) one line per SET CHANGE, never per round
    // -----------------------------------------------------------------

    describe('the hold is announced once per signer-set change', function () {

        it('says it once no matter how many rounds try to send', function () {
            attachPeer();
            pm.setEffectiveSignerSet(new Set([peer.pubkeyHex.toLowerCase()]));

            for (let i = 0; i < 200; i++) pm.broadcast('PBFT_PREPARE', { seq: i });

            expect(holdLines(), 'one line, not one per round').to.have.lengthOf(1);
            expect(holdLines()[0]).to.include('1-member');
            expect(holdLines()[0], 'the operator can match the key').to.include(me.pubkeyHex.toLowerCase());
        });

        it('stays silent when the refresh reinstalls the same members in a new Set', function () {
            attachPeer();
            for (let i = 0; i < 20; i++) {
                // What _refreshTransportSignerSet does every 30s: a new object, same members.
                pm.setEffectiveSignerSet(new Set([peer.pubkeyHex.toLowerCase()]));
                pm.broadcast('PBFT_PREPARE', { seq: i });
            }
            expect(holdLines(), 'the members did not change, so there is no news').to.have.lengthOf(1);
        });

        it('speaks again when the membership actually changes', function () {
            attachPeer();
            let third = ValidatorIdentity.generate();

            pm.setEffectiveSignerSet(new Set([peer.pubkeyHex.toLowerCase()]));
            pm.broadcast('PBFT_PREPARE', { seq: 1 });
            pm.setEffectiveSignerSet(new Set([peer.pubkeyHex.toLowerCase(), third.pubkeyHex.toLowerCase()]));
            pm.broadcast('PBFT_PREPARE', { seq: 2 });

            expect(holdLines(), 'a set of a different size is worth one more line').to.have.lengthOf(2);
            expect(holdLines()[1]).to.include('2-member');
            expect(frames, 'still nothing on the wire').to.have.lengthOf(0);
        });

        it('says so once when the hub is admitted, and then goes quiet', function () {
            attachPeer();
            pm.setEffectiveSignerSet(new Set([peer.pubkeyHex.toLowerCase()]));
            pm.broadcast('PBFT_PREPARE', { seq: 1 });

            pm.setEffectiveSignerSet(new Set([peer.pubkeyHex.toLowerCase(), me.pubkeyHex.toLowerCase()]));
            pm.broadcast('PBFT_PREPARE', { seq: 2 });
            pm.setEffectiveSignerSet(new Set([peer.pubkeyHex.toLowerCase(), me.pubkeyHex.toLowerCase()]));
            pm.broadcast('PBFT_PREPARE', { seq: 3 });

            expect(resumeLines(), 'one admission line').to.have.lengthOf(1);
            expect(holdLines(), 'and no second hold line').to.have.lengthOf(1);
            expect(frames, 'the admitted hub sends both later rounds').to.have.lengthOf(2);
        });
    });

    // -----------------------------------------------------------------

    // A checkpoint engine over an in-memory store, shaped like the cadence-stall
    // suite's. `indexerCalls` records every round trip the tick would make, so a
    // held tick can be shown to make none.
    function buildCheckpointEngine(peerManager) {
        const identity    = new ValidatorIdentity('11'.repeat(32));
        const checkpoints = [];
        const indexerCalls = [];
        const db = {
            checkpoints,
            async doQuery(sql, params) {
                if (sql.startsWith('SELECT MAX(checkpoint_seq)')) return [{ max_seq: null }];
                if (sql.startsWith('SELECT MAX(snapshot_block)')) return [{ last_block: null }];
                if (sql.startsWith('INSERT IGNORE INTO state_checkpoints')) {
                    checkpoints.push({ chain: params[0], checkpoint_seq: params[7], snapshot_block: params[8] });
                    return [];
                }
                if (sql.startsWith('SELECT * FROM state_checkpoints')) return [];
                return [];
            }
        };
        const validators = [{ pubkey: identity.getPubkeyHex().toLowerCase(), amount: '1' }];
        const hub = {
            db,
            network: 'regtest',
            p2pConfig: {
                CHECKPOINT_CHAINS: 'BTC', CHECKPOINT_CONFIRMATIONS: '0',
                CHECKPOINT_INTERVAL_BLOCKS: '6', BTC_INDEXER_URL: 'http://stub'
            },
            hubDbBroadcaster: { broadcastRow() {} },
            capabilitySnapshot: {
                async getSnapshot() { return { validators }; },
                async getWeightSnapshot() {
                    return { validators: validators.map(v => ({ pubkey: v.pubkey, source: 'src:' + v.pubkey, weight: v.amount })) };
                }
            },
            getPeerManager: () => peerManager,
            getIdentity: () => identity,
            _resolveBtcLatestBlock: async () => 100
        };
        const engine = new StateCheckpointEngine(hub);
        engine._indexerCall = async (chain, method) => { indexerCalls.push(chain + ':' + method); return Object.assign({}, TIP); };
        return { engine, indexerCalls, db };
    }
});
