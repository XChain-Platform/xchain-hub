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

// One archive publication at a time, across BOTH phases of a round.
//
// `_archiveRound` guards only signature collection: `_checkArchiveQuorum` clears it the
// instant quorum is met and only THEN awaits `_publishArchive`. That await is not
// covered by flush()'s `_flushing` mutex either, because quorum can arrive on a peer
// message (`_handleSign`), which runs outside flush entirely. And `_publishArchive`
// does not arm its durable dedupe marker (`_recordArchiveIntent`) until after the
// publisher-attestation round, so the live-intent gate at the top of the publish reads
// nothing for a publish already in flight: a timer or size flush landing in that window
// rebuilds the same still-pending rows and spends DOGE a second time.
//
// `_archivePublishing` covers quorum-to-return, so `_startArchiveRound` refuses. The
// second case pins the belt-and-braces half: a publisher-attestation round that
// displaces another must settle the one it displaces. The displaced round's timer is
// guarded on `this._archiveAttestRound === round`, so it no-ops, and
// `_checkArchiveAttestQuorum` only ever reads the live field - the `_publishArchive`
// awaiting the displaced round would otherwise wait forever, and nothing in the process
// would ever notice.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../src/StateAnchorPublisher');
const ValidatorIdentity    = require('../../src/ValidatorIdentity');
const { waitUntil }        = require('../helpers/waitUntil');

const BLOCK = 100;
const CP_ROW = {
    id: 1, chain: 'BTC', network: 'regtest', block_index: 500, block_hash: 'c0'.repeat(32),
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    checkpoint_seq: BLOCK, snapshot_block: BLOCK, state_root: null, block_merkle_root: null
};

function mkPub(){
    const identity = new ValidatorIdentity('11'.repeat(32));
    const pub = new StateAnchorPublisher({
        db: { async doQuery(){ return []; } },
        network: 'regtest', p2pConfig: {},
        getIdentity: () => identity,
        getPeerManager: () => ({ on(){}, removeListener(){}, broadcast(){} }),
        _resolveBtcLatestBlock: async () => BLOCK
    });
    return { pub, identity };
}

describe('StateAnchorPublisher archive publication guard', () => {

    it('refuses a new archive round while a publication is still in flight', async () => {
        const { pub } = mkPub();
        let releasePublish;
        let publishCalls = 0;
        pub._publishArchive = () => {
            publishCalls++;
            return new Promise((resolve) => { releasePublish = () => resolve('published'); });
        };
        // A quorum-met round, exactly the shape _checkArchiveQuorum acts on.
        pub._archiveRound = {
            batchSeq: 7, quorum: 1, weighted: false, done: false, timer: null,
            signatures: new Map([['aa'.repeat(16), 'sig']]),
            validators: [{ pubkey: 'aa'.repeat(16), source: 'src', weight: '1' }]
        };

        // Do NOT await: this is precisely the window the defect lives in.
        const quorumRun = pub._checkArchiveQuorum();
        expect(publishCalls, 'quorum did not reach the publish').to.equal(1);
        // The finding's title, asserted directly: the signing-phase guard IS released
        // while the publication is still running, so something else has to cover it.
        expect(pub._archiveRound, '_archiveRound is released at quorum').to.equal(null);
        expect(pub._archivePublishing, 'nothing covers the in-flight publication').to.not.equal(null);

        // A flush landing inside that window must find the path taken.
        const verdict = await pub._startArchiveRound({ broadcastFn: () => {} }, BLOCK, false);
        expect(verdict).to.equal('round_pending');
        expect(publishCalls, 'a second publication started inside the window').to.equal(1);

        releasePublish();
        await quorumRun;
        expect(pub._archivePublishing, 'the guard outlived the publication').to.equal(null);

        // And the next round is admitted again: the guard bounds, it does not latch.
        pub._startArchiveRound = StateAnchorPublisher.prototype._startArchiveRound;
        expect(pub._archiveRound || pub._archivePublishing).to.equal(null);
    });

    it('clears the guard when the publication throws', async () => {
        const { pub } = mkPub();
        pub._publishArchive = async () => { throw new Error('doge rpc down'); };
        pub._archiveRound = {
            batchSeq: 8, quorum: 1, weighted: false, done: false, timer: null,
            signatures: new Map([['aa'.repeat(16), 'sig']]),
            validators: [{ pubkey: 'aa'.repeat(16), source: 'src', weight: '1' }]
        };
        let threw = false;
        try { await pub._checkArchiveQuorum(); } catch(e){ threw = true; }
        expect(threw, 'the publish failure must still propagate').to.equal(true);
        expect(pub._archivePublishing, 'a failed publish latched the guard forever').to.equal(null);
    });

    it('settles the publisher-attestation round it displaces', async () => {
        const { pub, identity } = mkPub();
        const me = identity.getPubkeyHex().toLowerCase();
        // A three-member signing set including this hub, so the round opens a real
        // promise instead of short-circuiting on the single-node path. The sources are
        // DISTINCT on purpose: the stake tally sums distinct-source stake, so a shared
        // source would credit this hub's lone signature with the whole set's weight and
        // the round would meet quorum on the spot.
        pub._resolveCapabilitySet = async () => ([
            { pubkey: me,              source: 'sA', amount: '1' },
            { pubkey: 'bb'.repeat(16), source: 'sB', amount: '1' },
            { pubkey: 'cc'.repeat(16), source: 'sC', amount: '1' }
        ]);
        pub.peerManager  = { broadcast(){} };
        pub.roundTimeoutMs = 60000;                 // the timer must not be what settles these
        const cp = pub._cpFromRow(CP_ROW);

        // Record the displaced round's outcome rather than awaiting it: the whole point
        // is that before the fix it never arrives, so nothing may block on it.
        let firstOutcome = null;
        const first = pub._runArchiveAttestationRound(cp, 11, me)
            .then((v) => { firstOutcome = v; });
        // Let the first round install itself before the second displaces it.
        await new Promise((r) => setImmediate(r));
        const second = pub._runArchiveAttestationRound(cp, 12, me);

        await waitUntil(() => firstOutcome, { timeoutMs: 1000, label: 'the displaced round to settle' });
        expect(firstOutcome).to.deep.equal({ met: false, sigs: [] });
        await first;
        expect(pub._archiveAttestRound, 'the live round is the displacing one').to.not.equal(null);
        expect(pub._archiveAttestRound.batchSeq).to.equal(12);

        pub.stop();                                  // settles the survivor
        await second;
    });
});
