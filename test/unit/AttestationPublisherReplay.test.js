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

// Regression coverage for AttestationPublisher crash-replay + follower failover.
//
// The attestation-queue.jsonl is a durable write-ahead log: a finalized response
// must survive a leader crash between the queue write and the on-chain broadcast,
// and a follower must step in if the leader goes silent. The indexer's pending-
// request set is the authoritative double-broadcast guard — an entry whose request
// is no longer pending has already landed (or expired) and must NOT be re-broadcast.

const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const sinon = require('sinon');
const { expect } = require('chai');
const AttestationPublisher = require('../../src/AttestationPublisher');

const MY_PUB     = 'aa'.repeat(32);
const LEADER_PUB = 'bb'.repeat(32);

function makeHub(myPub) {
    return {
        getIdentity: () => ({ getPubkeyHex: () => myPub }),
        p2pConfig: {},
        attestationConsensus: null,  // start() won't subscribe; we drive methods directly
        capabilitySnapshot: {
            // Default: this node + a leader both qualify
            getSnapshot: async () => ({ validators: [{ pubkey: MY_PUB }, { pubkey: LEADER_PUB }] })
        },
        _resolveBtcIndexerUrl: async () => 'http://indexer.local/rpc',
        _btcIndexerHeaders: () => ({})
    };
}

function writeQueue(file, entries) {
    fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

function readQueue(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

describe('AttestationPublisher — crash replay + follower failover', function () {

    let queueFile;

    beforeEach(function () {
        queueFile = path.join(os.tmpdir(), 'attq-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.jsonl');
    });

    afterEach(function () {
        sinon.restore();
        try { fs.unlinkSync(queueFile); } catch (_) {}
    });

    function makePublisher(myPub) {
        const pub = new AttestationPublisher(makeHub(myPub || MY_PUB));
        pub.queuePath = queueFile;
        return pub;
    }

    it('replays a crash-surviving leader entry whose request is still pending', async function () {
        const pub = makePublisher();
        const bcast = sinon.stub().resolves({ txid: 'replay-txid' });
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, '_fetchPendingRequestIds').resolves(new Set(['cc' + 'cc'.repeat(31)]));

        const rid = 'cc' + 'cc'.repeat(31);
        writeQueue(queueFile, [{
            ts: Date.now() - 10 * 60000,          // old — survived a crash
            requestId: rid,
            wire: 'ATTEST|1|' + rid + '|http_get|Zm9v|ok||1|' + MY_PUB + '|' + 'ee'.repeat(64),
            responsible: [MY_PUB, LEADER_PUB],     // we are leader (rank 0)
            leaderPubkey: MY_PUB
        }]);

        await pub._processQueue();

        expect(bcast.calledOnce).to.equal(true, 'leader entry should be re-broadcast');
        expect(readQueue(queueFile)).to.have.length(0, 'entry should be dropped after success');
    });

    it('drops a queued entry whose request is no longer pending, WITHOUT re-broadcasting', async function () {
        const pub = makePublisher();
        const bcast = sinon.stub().resolves({ txid: 'should-not-fire' });
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, '_fetchPendingRequestIds').resolves(new Set());  // nothing pending — already landed

        const rid = 'dd' + 'dd'.repeat(31);
        writeQueue(queueFile, [{
            ts: Date.now() - 10 * 60000,
            requestId: rid,
            wire: 'ATTEST|1|' + rid + '|http_get|Zm9v|ok||1|' + MY_PUB + '|' + 'ee'.repeat(64),
            responsible: [MY_PUB],
            leaderPubkey: MY_PUB
        }]);

        await pub._processQueue();

        expect(bcast.called).to.equal(false, 'must not re-broadcast an already-landed response');
        expect(readQueue(queueFile)).to.have.length(0, 'resolved entry should be cleared from the queue');
    });

    it('holds a follower entry until the leader-silence window elapses, then steps in', async function () {
        const pub = makePublisher();
        pub.failoverWindowBlocks = 2;
        pub.approxBlockMs = 1000;        // rank-1 window = 2 * 1000 = 2000ms
        const bcast = sinon.stub().resolves({ txid: 'stepin-txid' });
        pub.setBroadcastHook(bcast);
        const rid = 'ff' + 'ff'.repeat(31);
        sinon.stub(pub, '_fetchPendingRequestIds').resolves(new Set([rid]));

        const baseEntry = {
            requestId: rid,
            wire: 'ATTEST|1|' + rid + '|http_get|Zm9v|ok||1|' + LEADER_PUB + '|' + 'ee'.repeat(64),
            responsible: [LEADER_PUB, MY_PUB],   // leader is someone else; we are rank 1
            leaderPubkey: LEADER_PUB
        };

        // Fresh entry — within the window, follower must NOT broadcast yet.
        writeQueue(queueFile, [Object.assign({ ts: Date.now() }, baseEntry)]);
        await pub._processQueue();
        expect(bcast.called).to.equal(false, 'follower must wait out the leader-silence window');
        expect(readQueue(queueFile)).to.have.length(1, 'entry retained while waiting');

        // Aged past the window — follower steps in.
        writeQueue(queueFile, [Object.assign({ ts: Date.now() - 5000 }, baseEntry)]);
        await pub._processQueue();
        expect(bcast.calledOnce).to.equal(true, 'follower steps in after leader silence');
        expect(readQueue(queueFile)).to.have.length(0);
    });

    it('leader live broadcast on finalization enqueues then drops the entry on success', async function () {
        const pub = makePublisher();
        const bcast = sinon.stub().resolves({ txid: 'live-txid' });
        pub.setBroadcastHook(bcast);

        await pub.onRequestFinalized({
            requestId: '11'.repeat(32),
            providerId: 'http_get',
            responseBody: Buffer.from('foo'),
            status: 'ok',
            meta: '',
            signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }],
            leaderPubkey: MY_PUB,
            request: { block_index: 5, redundancy: 1 }
        });

        expect(bcast.calledOnce).to.equal(true, 'leader broadcasts immediately');
        expect(readQueue(queueFile)).to.have.length(0, 'successful live broadcast drops its WAL entry');
    });

    it('follower on finalization persists the entry but does not broadcast', async function () {
        const pub = makePublisher();
        const bcast = sinon.stub().resolves({ txid: 'nope' });
        pub.setBroadcastHook(bcast);

        await pub.onRequestFinalized({
            requestId: '22'.repeat(32),
            providerId: 'http_get',
            responseBody: Buffer.from('foo'),
            status: 'ok',
            meta: '',
            signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }],
            leaderPubkey: LEADER_PUB,             // someone else leads
            request: { block_index: 5, redundancy: 2 }
        });

        expect(bcast.called).to.equal(false, 'follower must not broadcast on finalization');
        expect(readQueue(queueFile)).to.have.length(1, 'follower persists the finalized payload for failover');
    });

    it('defers replay (retains the queue) when the indexer is unreachable', async function () {
        const pub = makePublisher();
        const bcast = sinon.stub().resolves({ txid: 'nope' });
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, '_fetchPendingRequestIds').resolves(null);  // indexer unreachable

        const rid = '33'.repeat(32);
        writeQueue(queueFile, [{
            ts: Date.now() - 10 * 60000,
            requestId: rid,
            wire: 'ATTEST|1|' + rid + '|http_get|Zm9v|ok||1|' + MY_PUB + '|' + 'ee'.repeat(64),
            responsible: [MY_PUB],
            leaderPubkey: MY_PUB
        }]);

        await pub._processQueue();

        expect(bcast.called).to.equal(false, 'must not broadcast when pending-state is unknown');
        expect(readQueue(queueFile)).to.have.length(1, 'queue retained for a later sweep');
    });
});
