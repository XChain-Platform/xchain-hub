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
// StateAnchorPublisher: v1 + v2 chunking, the flush summary, re-archival after
// lost chunks or a retraction, the txn-mempool-conflict retry, XCALL relay rows
// on the archive, and follower refusal of divergent call terms.
// The mesh harness lives in test/helpers/anchor_mesh.js.

const { expect }            = require('chai');
const zlib                  = require('zlib');
const { waitUntil }         = require('../../../helpers/waitUntil');
const { CP_ROW, matchRow, callRow, buildMesh, archiveLeader, startAll, registerMeshHooks } = require('../../../helpers/anchor_mesh.js');

describe('StateAnchorPublisher', function () {
    registerMeshHooks();

    registerChunkingAndSummaryCases();
    registerLostChunkCase();
    registerMempoolRetryCase();
    registerReArchiveCases();
    registerCallTermsCase();
});

// Oversized archives chunk and reassemble; flush returns an honest summary.
function registerChunkingAndSummaryCases() {
    it('oversized archive splits into v1 + v2 chunks that reassemble byte-identically', async function () {
        let many = [];
        for (let i = 0; i < 40; i++) many.push(matchRow('m' + String(i).padStart(3, '0')));
        let bus = buildMesh(1, { network: 'mainnet', matches: many, cfg: { ANCHOR_CHUNK_MAX_BYTES: '500' } });   // count-path chunking mechanics (SWQ off below 961000)
        let nd = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        await waitUntil(() => nd.published[1] && nd.published.length >= 1 + Number(nd.published[1].split('|')[14]), { label: 'every v1 + v2 archive chunk to be broadcast' });

        let v1 = nd.published[1].split('|');
        let total = Number(v1[14]);
        expect(total).to.be.greaterThan(1);
        expect(nd.published.length).to.equal(1 + total);               // v0 + v1 + (total-1) v2s
        let b64 = v1[15];
        for (let i = 2; i < nd.published.length; i++) {
            let v2 = nd.published[i].split('|');
            expect(v2[1]).to.equal('2');
            expect(Number(v2[2])).to.equal(0);                          // MATCH_BATCH_SEQ
            expect(Number(v2[3])).to.equal(i - 1);                      // CHUNK_INDEX
            expect(Number(v2[4])).to.equal(total);
            b64 += v2[5];
        }
        let archive = JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64url')).toString('utf8'));
        expect(archive.matches.length).to.equal(40);
    });

    it('flush returns a summary (and reports election skips honestly)', async function () {
        // Weighted-path: this test asserts the anchored summary carries network 'regtest'
        // (below), so the record must stay regtest, which activates SWQ at block 0. One
        // equal-weight source clears the 2/3 bar trivially, so the summary is unchanged.
        let bus = buildMesh(1, { stakeWeighted: true });
        let nd = bus.nodes[0];
        await startAll(bus);
        let first = await nd.pub.flush();
        expect(first.anchored.length).to.equal(1);
        expect(first.anchored[0]).to.include({ chain: 'BTC', network: 'regtest', block_index: 494 });
        expect(first.anchored[0].txid).to.be.a('string');
        expect(first.archive).to.equal('published');

        let second = await nd.pub.flush();
        expect(second.anchored.length).to.equal(0);
        expect(second.archive).to.equal('none');
    });
}

// A batch that loses v2 chunks re-archives under a fresh seq.
function registerLostChunkCase() {
    it('a batch that loses v2 chunks is NOT marked archived and re-archives under a fresh seq', async function () {
        // Live finding (bug G): chunk broadcasts hitting txn-mempool-conflict
        // were lost while the batch was already back-filled as archived - an
        // unrecoverable archive (recovery refuses incomplete batches). A partial
        // publish must keep the rows pending and the retry must use a NEW seq
        // (two v1 anchors sharing one seq corrupt chunk reassembly).
        let bus = buildMesh(1, { network: 'mainnet',   // count-path re-archive mechanics (SWQ off below 961000)
                                 cfg: { ANCHOR_CHUNK_MAX_BYTES: '600', ANCHOR_CHUNK_RETRY_MS: '1' },
                                 matches: [matchRow('m1'), matchRow('m2'), matchRow('m3')] });
        let nd = bus.nodes[0];
        let dropChunks = true;
        nd.pub.setBroadcastHook(async (payload) => {
            if (dropChunks && payload.split('|')[1] === '2') throw new Error('txn-mempool-conflict');
            nd.published.push(payload);
            return { txid: 'txid' + nd.published.length };
        });
        await startAll(bus);
        await nd.pub.flush();
        await waitUntil(() => nd.published.some(p => p.split('|')[1] === '1'), { label: 'the v1 archive head to be broadcast' });

        // v1 went out but the batch must stay pending (sentinel ≠ real status)
        let v1a = nd.published.find(p => p.split('|')[1] === '1');
        expect(v1a, 'v1 broadcast').to.exist;
        let seqA = Number(v1a.split('|')[11]);
        for (let r of nd.db.matches) {
            expect(r.batch_seq, 'seq advances even on partial').to.equal(seqA);
            expect(r.archived_status).to.equal('__partial__');
        }

        // chunks deliverable again → next flush re-archives EVERYTHING under a new seq
        dropChunks = false;
        await nd.pub.flush();
        await waitUntil(() => nd.published.filter(p => p.split('|')[1] === '1').length === 2, { label: 'the retry flush to re-archive under a second v1' });
        let v1s = nd.published.filter(p => p.split('|')[1] === '1');
        expect(v1s.length).to.equal(2);
        let seqB = Number(v1s[1].split('|')[11]);
        expect(seqB, 'fresh seq for the retry').to.be.greaterThan(seqA);
        for (let r of nd.db.matches) {
            expect(r.batch_seq).to.equal(seqB);
            expect(r.archived_status).to.equal(r.status);                  // now genuinely archived
        }
    });
}

// v0 publishes retry through txn-mempool-conflict.
function registerMempoolRetryCase() {
    it('v0 publishes retry through txn-mempool-conflict (and stay pending when exhausted)', async function () {
        // Live finding (first prod ANCHOR cycle post-XCALL deploy): multiple
        // chains' v0 anchors broadcast back-to-back from the one publisher
        // wallet; without a retry only the first landed each 30-min cycle and
        // DOGE/LTC staggered one chain per flush on 258: txn-mempool-conflict.
        let bus = buildMesh(1, { cfg: { ANCHOR_CHUNK_RETRY_MS: '1' } });
        let nd = bus.nodes[0];
        let v0Failures = 0, failuresLeft = 2;
        nd.pub.setBroadcastHook(async (payload) => {
            if (payload.split('|')[1] === '0' && failuresLeft > 0) {
                failuresLeft--; v0Failures++;
                throw new Error('Encoder RPC error: 258: txn-mempool-conflict');
            }
            nd.published.push(payload);
            return { txid: 'txid' + nd.published.length };
        });
        await startAll(bus);
        await nd.pub.flush();
        await waitUntil(() => nd.db.checkpoints[0].anchor_txid === 'txid1', { label: 'the retried v0 broadcast to stamp the checkpoint' });

        // Two conflicts absorbed by the retry - the checkpoint still anchors this flush.
        expect(v0Failures).to.equal(2);
        expect(nd.db.checkpoints[0].anchor_txid).to.equal('txid1');

        // Exhausted retries (5 straight conflicts) leave the row pending for the next flush.
        nd.db.checkpoints.push(Object.assign({}, CP_ROW, { id: 2, chain: 'DOGE', anchor_txid: null }));
        failuresLeft = 99;
        await nd.pub.flush();
        expect(nd.db.checkpoints[1].anchor_txid).to.equal(null);

        failuresLeft = 0;
        await nd.pub.flush();
        await waitUntil(() => typeof nd.db.checkpoints[1].anchor_txid === 'string', { label: 'the conflict-free flush to anchor the deferred row' });
        expect(nd.db.checkpoints[1].anchor_txid).to.be.a('string');
    });
}

// A retracted match re-archives, and XCALL relay rows ride the archive.
function registerReArchiveCases() {
    it('a match retracted after archival is re-archived with its new status', async function () {
        let bus = buildMesh(1, { network: 'mainnet' });   // count-path re-archive mechanics (SWQ off below 961000)
        let nd = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        await waitUntil(() => nd.db.matches[0].batch_seq === 0, { label: 'the first archive to claim the match row' });
        expect(nd.db.matches[0].batch_seq).to.equal(0);

        // Reorg retraction after archival → pending again under the re-archival rule.
        nd.db.matches[0].status = 'retracted';
        nd.db.checkpoints[0].anchor_txid = 'already';                  // no new v0 this flush
        await nd.pub.flush();
        await waitUntil(() => nd.published.filter(p => p.split('|')[1] === '1').length === 2, { label: 'the retracted match to be re-archived under a second v1' });

        let v1s = nd.published.filter(p => p.split('|')[1] === '1');
        expect(v1s.length).to.equal(2);
        let last = v1s[1].split('|');
        expect(Number(last[11])).to.equal(1);                          // new batch_seq
        let archive = JSON.parse(zlib.gunzipSync(Buffer.from(last[15], 'base64url')).toString('utf8'));
        expect(archive.matches[0].status).to.equal('retracted');
        expect(nd.db.matches[0].batch_seq).to.equal(1);
        expect(nd.db.matches[0].archived_status).to.equal('retracted');
    });

    it('XCALL relay rows ride the archive (both phases) and back-fill batch metadata', async function () {
        let bus = buildMesh(1, { network: 'mainnet', calls: [callRow('c'.repeat(64), 'dispatch'), callRow('c'.repeat(64), 'result')] });   // count-path XCALL archive mechanics (SWQ off below 961000)
        let nd = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        await waitUntil(() => nd.published.some(p => p.split('|')[1] === '1'), { label: 'the XCALL-bearing archive to be broadcast' });

        let v1s = nd.published.filter(p => p.split('|')[1] === '1');
        expect(v1s.length).to.equal(1);
        let f = v1s[0].split('|');
        let archive = JSON.parse(zlib.gunzipSync(Buffer.from(f[15], 'base64url')).toString('utf8'));
        // Fixed-key-order call records, both phases, alongside the match.
        expect(archive.matches.length).to.equal(1);
        expect(archive.calls.length).to.equal(2);
        expect(archive.calls[0].phase).to.equal('dispatch');
        expect(archive.calls[0].result_status).to.equal(null);
        expect(archive.calls[1].phase).to.equal('result');
        expect(archive.calls[1].result_status).to.equal('ok');
        expect(archive.calls[1].return_payload_b64).to.equal('cGF5bG9hZA');
        // The cross_chain snapshot for the calls' snapshot_block is self-contained.
        expect(archive.capability_snapshots.some(s => s.capability === 'cross_chain' && s.snapshot_block === 100)).to.equal(true);
        // Batch metadata back-filled on both phases; a second flush archives nothing.
        for (let c of nd.db.calls) {
            expect(c.batch_seq).to.equal(0);
            expect(c.archived_status).to.equal('finalized');
        }
        nd.db.checkpoints[0].anchor_txid = 'already';
        let second = await nd.pub.flush();
        expect(second.archive).to.equal('none');
    });
}

// A follower refuses an archive whose call terms diverge from its DB.
function registerCallTermsCase() {
    it('a follower refuses to co-sign an archive whose call terms diverge from its DB', async function () {
        let bus = buildMesh(4, {
            calls: [callRow('d'.repeat(64), 'dispatch')],
            btcBlock: 300
        });
        // Two non-leader nodes hold a mutated copy of the call → no quorum forms.
        let leader = archiveLeader(bus);
        let mutated = 0;
        for (let nd of bus.nodes) {
            if (nd !== leader && mutated < 2) { nd.db.calls[0].gas_limit = 999999; mutated++; }
        }
        await startAll(bus);
        // Same shape as the diverging-match round above: the awaited flush settles the
        // refusal, so nothing remains to poll for.
        await leader.pub.flush();
        for (let nd of bus.nodes) expect(nd.db.calls[0].batch_seq).to.equal(null);
    });
}
