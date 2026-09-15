/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * ANCHOR publisher - publishing a v1 archive
 *
 * The archive head and its v2 continuation chunks: intent, attestation, the
 * chunk broadcasts and the FINALIZED announcement.
 *
 ********************************************************************/

'use strict';

const ar = require('../../../anchor_reward_activation.js');
const { XANC_FINALIZED } = require('../constants.js');
const { getLogger } = require('../../../observability');
const logger = getLogger();

module.exports = {

    async _publishArchive(round){
        let sigs = [];
        for(let [pk, sg] of round.signatures) sigs.push({ pubkey: pk, sig: sg });

        let cp      = round.cp;
        let network = String(cp.network);
        let liveIntent = await this.getLiveArchiveIntent(network);
        if(this.archiveIntentHeld(liveIntent, round)) return 'intent_held';

        let me = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
        let attest = await this.collectArchiveAttestation(cp, round, me);
        let v1Payload = this.archiveHeadPayload(cp, round, sigs, me, attest.sigs);
        let broadcaster = round.signer.broadcastFn || ((p) => this.defaultBroadcast(p, round.signer));
        // Chunks descend from the head by design: they go out back-to-back from the
        // same wallet and there is no confirmed output between them, so they are the
        // one broadcast that may spend unconfirmed change. A chunk paying the target
        // rate mines right behind a head that mines; a head that does not mine is
        // caught by the confirmation watchdog, not by starving its chunks.
        let chunkBroadcaster = round.signer.broadcastFn ||
            ((p) => this.defaultBroadcast(p, round.signer, { allowUnconfirmed: true }));
        let result = await this.sendArchiveHead(network, round, broadcaster, v1Payload, cp);
        let txid = result && result.txid ? result.txid : null;
        if(txid) await this.markArchiveSent(network, round.batchSeq, txid);
        if(txid && !(result && result.exists)) this.notePendingConfirmation('archive_head', txid, String(round.batchSeq));
        let chunkSeq = this.adoptedChunkSeq(result, round, txid);
        let lostChunks = await this.broadcastArchiveChunks(round, chunkSeq, chunkBroadcaster, cp);
        let onChainValid = this.archiveOnChainValid(round, sigs);
        let noTxid = !txid;
        let ids = this.archiveBackfillIds(round, lostChunks, onChainValid, noTxid);
        await this.backfillBatch(round.batchSeq, ids.matchIds, txid, ids.callIds, ids.rewardIds);
        // Bookkeeping is done, so the crash window this marker covers is closed: settle it
        // and let the next round start immediately. Settling is gated on a real txid
        // because a null one is a false/incomplete broadcast success, NOT proof that
        // nothing was sent (the same reasoning that leaves the checkpoint marker armed on
        // a null txid); leaving it unsettled makes the TTL, rather than this flush, decide
        // when a possibly-paid batch may be rebuilt. A partial archive (lost chunks /
        // invalid on-chain quorum) DOES settle: its rows re-archive under a fresh seq by
        // design, and the head we paid for is accounted for.
        if(txid) await this.settleArchiveIntent(network, round.batchSeq);
        this.announceArchiveFinalized(round, txid, ids);
        if(lostChunks === 0 && onChainValid && !noTxid)
            this.recordArchivePublish(round, txid, attest.attested, attest.sigs);
    },

    // Last gate before anything is spent, mirroring the pre-broadcast marker read in
    // _publishPendingCheckpoints. _startArchiveRound checks this before the round
    // opens, but a co-signed round reaches here minutes later and _publishArchive is
    // reachable from other paths, so re-read: any UNSETTLED intent for this network
    // belongs to an earlier round that may already have paid, and this round's own
    // intent is not armed until just before its send. Checked ahead of the
    // publisher-attestation round so a held publish does not burn a peer quorum
    // either. Fails closed (a DB read error throws and the rows stay pending) rather
    // than spending against publish history it could not read.
    // True when an unsettled intent from an earlier round holds this publish.
    archiveIntentHeld(liveIntent, round){
        if(this.anchorIntentHolds(liveIntent)){
            logger.warn('StateAnchorPublisher: archive batch ' + round.batchSeq + ' NOT published: batch ' +
                         liveIntent.batch_seq + ' recorded a broadcast intent at ' + String(liveIntent.intent_at) +
                         ' that never finished; rows stay pending and re-archive under a fresh seq once it ' +
                         'settles or ages past ' + this.anchorIntentTtlMs + 'ms');
            return true;
        }
        return false;
    },

    // Archive-reward re-derivation flag-day: at/above it, run the archive
    // publisher-attestation round (2f+1 oracle_publish quorum over the archive XANCPUB
    // canonical binding THIS hub as the earner) so the indexer DERIVES the
    // anchor_archive reward and the last key-authenticated push is retired.
    // LIVENESS-SAFE: a degraded round (timeout / short quorum / not a snapshot member)
    // still emits the SAME v1 wire, with ATTEST_SIG_COUNT 0 (D4), so the archive
    // always lands; only reward issuance gains the quorum dependency.
    // The publisher-attestation tail: `attested` only when a reward-derivable tail was
    // actually collected, with the signatures it carries.
    async collectArchiveAttestation(cp, round, me){
        let attested = false;
        let attestSigs = [];
        if(me && ar.isArchiveRewardActive(Number(cp.snapshot_block), cp.network)){
            let attest = await this.runArchiveAttestationRound(cp, round.batchSeq, me);
            if(attest && attest.met && attest.sigs.length >= 1){
                attestSigs = attest.sigs;
                attested = true;
            } else {
                logger.warn('StateAnchorPublisher: archive publisher-attestation quorum not reached for batch ' +
                             round.batchSeq + '; publishing v1 with ATTEST_SIG_COUNT 0 (archive lands, no reward)');
            }
        }
        return { attested, sigs: attestSigs };
    },

    // ONE archive-head wire, always v1 (D4). The version byte no longer encodes
    // whether the attestation round met quorum: the degraded round emits the same v1
    // with ATTEST_SIG_COUNT 0, exactly as the v0 bundle leg already does. A second
    // tail-less shape would need its own parser branch on every consumer and buys
    // nothing the count field does not already say.
    archiveHeadPayload(cp, round, sigs, me, attestSigs){
        let parts = ['ANCHOR', '1', cp.chain, cp.network, String(cp.block_index), cp.block_hash,
                     cp.ledger_hash, cp.actions_hash, cp.contract_hash,
                     String(cp.checkpoint_seq), String(cp.snapshot_block),
                     String(round.batchSeq), String(round.count), round.crc,
                     String(round.chunks.length), round.chunks[0], String(sigs.length)];
        for(let s of sigs) parts.push(s.pubkey, s.sig);
        // The publisher tail is UNCONDITIONAL. Field order MUST match the indexer parser
        // (anchor.js formats[1]):
        // ...|SIG_COUNT|PUBKEY|SIG|...|PUBLISHER|ATTEST_SIG_COUNT|APUBKEY|ASIG|...
        // Mirrors _buildV7Payload's tail, empty-publisher fallback included, so the two
        // legs degrade identically.
        parts.push(String(me || '').toLowerCase(), String(attestSigs.length));
        for(let s of attestSigs) parts.push(String(s.pubkey).toLowerCase(), String(s.sig).toLowerCase());
        return parts.join('|');
    },

    // Armed BEFORE the send, so the window this marker covers starts at the earliest
    // moment DOGE could have moved, and stays armed across the whole v2 chunk loop:
    // a crash anywhere in the round is one unfinished archive, not one per chunk.
    // Arm the intent and send the v1 head; the broadcast result comes back for the
    // caller to record, and the intent stays armed across the chunk loop that follows.
    async sendArchiveHead(network, round, broadcaster, v1Payload, cp){
        await this.recordArchiveIntent(network, round.batchSeq);
        let result;
        try {
            // The durable intent above holds a crashed round for anchorIntentTtlMs; this
            // is the part that settles it, and the part that covers the window AFTER the
            // TTL expires. getarchiveanchor answers "did we already publish THIS batch"
            // from the batch's content (checkpoint identity + crc + count) rather than
            // from the match_batch_seq the restart no longer preserves, so an archive
            // that already reached DOGE is ADOPTED here instead of paid for twice.
            result = await this.broadcastWithRetry(broadcaster, v1Payload, undefined,
                () => this.findExistingArchiveAnchor(cp, round));
        } catch(e){
            // A definitive failure means nothing reached the DOGE node (pre-send
            // build/sign errors, a spend-ceiling refusal, an RPC rejection), so withdraw
            // rather than stall archiving for the whole TTL over a send that never
            // happened. An AMBIGUOUS send KEEPS its intent: that case is exactly what the
            // marker exists for.
            if(!(e && e.anchorAmbiguousSend)) await this.withdrawArchiveIntent(network, round.batchSeq);
            throw e;
        }
        return result;
    },

    // The seq the chunks must be addressed to. Normally this round's own, but when
    // the head above was ADOPTED it is the seq that head actually landed under,
    // which this process could not know (the re-election allocated a different one).
    // Chunks broadcast under any other number are orphans: they would carry the
    // archive bytes but attach to no head, and the batch would never reassemble.
    // Only the CHUNK addressing moves. Local bookkeeping (backfillBatch, the
    // FINALIZED announcement, the reward's round reference) stays on round.batchSeq,
    // because peers observed this round's SIGN_REQ under that seq and authenticate
    // the FINALIZED against it; nothing binds the local seq to match_batch_seq.
    adoptedChunkSeq(result, round, txid){
        let chunkSeq = (result && result.archiveAnchor && result.archiveAnchor.match_batch_seq != null)
            ? Number(result.archiveAnchor.match_batch_seq) : round.batchSeq;
        if(chunkSeq !== round.batchSeq){
            logger.info('StateAnchorPublisher: adopted an already-published archive head (txid ' + txid +
                        ', batch ' + chunkSeq + ') for round ' + round.batchSeq +
                        '; remaining chunks go out under the adopted seq');
            // Stale-seq convergence: the chain itself says this batch landed under a HIGHER seq than the
            // one our rows produced, which is the on-chain form of "we are behind on the
            // back-fill". Strongest evidence available (no peer asserted it), so feed the
            // floor and stop the next round from re-drawing a seq DOGE already carries.
            this.noteConsumedBatchSeq(chunkSeq, 'archive head found on DOGE under batch ' + chunkSeq);
        }
        return chunkSeq;
    },

    // Broadcast every v2 continuation chunk under `chunkSeq`; the number lost after retries.
    async broadcastArchiveChunks(round, chunkSeq, chunkBroadcaster, cp){
        let lostChunks = 0;
        for(let i = 1; i < round.chunks.length; i++){
            let v2Payload = ['ANCHOR', '2', String(chunkSeq), String(i), String(round.chunks.length), round.chunks[i]].join('|');
            // A lost chunk is a durability failure (recovery needs every chunk),
            // so the shared anchor-broadcast retry matters most here.
            // The same content-addressed check guards each chunk slot: a crash can land
            // the head and only some of its chunks, and without per-slot resolution the
            // resume would either re-pay for the chunks that landed or strand the batch.
            try {
                let chunkResult = await this.broadcastWithRetry(chunkBroadcaster, v2Payload, undefined,
                      () => this.findExistingArchiveChunk(cp, round, i));
                if(chunkResult && chunkResult.txid && !chunkResult.exists)
                    this.notePendingConfirmation('archive_chunk', chunkResult.txid, round.batchSeq + '/' + i);
            }
            catch(e){
                lostChunks++;
                this._archiveChunkLosses++;
                logger.error('StateAnchorPublisher: v2 chunk ' + i + ' broadcast failed after retries: ' + (e && e.message));
            }
        }
        return lostChunks;
    },

    // On-chain VALIDITY gate: the source rows are only safe to DEQUEUE if the
    // v1 we just broadcast will pass the indexer's own check. Its wrapper
    // signatures must reach quorum over oracle_publish @ snapshot_block, the
    // SAME set + threshold the indexer (anchor.js) and full-parse recovery
    // verify against. If they don't (e.g. a validator-set drift the signing
    // round could not satisfy), the on-chain v1 is stored `invalid`; dequeuing
    // the rows anyway would strand settled cross_chain_matches/calls in an
    // unrecoverable hole. Treat it exactly like a lost chunk: keep the rows
    // pending so a later round re-archives them under a fresh batch seq.
    //
    // quorumVerified is the SOLE verdict. A `round.validators.length === 1`
    // short-circuit used to sit in front of it, justified by the claim that the
    // indexer stores single-validator anchors as recoverable 'unverified'. It does
    // not: anchor.js reaches 'unverified' only when it mirrors NO oracle_publish
    // snapshot at all (oracleN === 0). With a one-member set and a signature from
    // outside it, its membership filter yields zero valid signers and the anchor
    // records 'invalid: insufficient valid signatures (0/1)', while full-parse
    // recovery throws on the same wrapper - so the bypass dequeued settled rows
    // behind an anchor neither the live indexer nor recovery can ever reconstruct.
    // The legitimate single-node federation is unaffected: a sole member that signed
    // its own archive clears quorumVerified on its own (bftQuorumOrSingle(1, 1) === 1).
    // A weighted singleton whose stake is zero, blank-sourced or truncated now fails
    // closed, which is parity with anchor.js reaching the same verdict on the same
    // bytes, not a regression: the rows stay pending instead of being stranded.
    archiveOnChainValid(round, sigs){
        return this.quorumVerified(round.canonical, sigs, round.validators, round.weighted);
    },

    // A partially-published archive is unrecoverable (recovery refuses
    // incomplete batches), so the rows must NOT be marked archived. Back-fill
    // with a sentinel archived_status instead: batch_seq still advances (a
    // re-archive must get a FRESH seq; two v1 anchors sharing one seq would
    // corrupt chunk reassembly) while `archived_status <> status` keeps every
    // row eligible, so the next flush re-archives the whole batch.
    // A null txid is a false/incomplete broadcast success (defaultBroadcast falls
    // back to { txid: null }); the v1 never landed on-chain, so dequeuing the rows
    // with their final status would strand them in an unrecoverable hole and the
    // archive reward would be credited for an anchor that was never published. Treat
    // it exactly like a lost chunk: keep the rows pending under a fresh batch seq.
    // (Mirrors the v0 null-txid guard in _publishPendingCheckpoints.)
    // The id lists backfillBatch stamps: the round's own when the archive landed whole,
    // the '__partial__' sentinel (and no rewards) when it did not.
    archiveBackfillIds(round, lostChunks, onChainValid, noTxid){
        let matchIds = round.matchIds, callIds = round.callIds || [], rewardIds = round.rewardIds || [];
        if(lostChunks > 0 || !onChainValid || noTxid){
            matchIds  = matchIds.map(m => Object.assign({}, m, { status: '__partial__' }));
            callIds   = callIds.map(c => Object.assign({}, c, { status: '__partial__' }));
            rewardIds = [];                  // reward rows stay pending (batch_seq NULL) and re-archive
            if(lostChunks > 0)
                logger.error('StateAnchorPublisher: batch ' + round.batchSeq + ' lost ' + lostChunks +
                              ' chunk(s) on-chain; rows stay pending and re-archive under a new batch seq' +
                              ' (cumulative chunk losses: ' + this._archiveChunkLosses + ')');
            if(!onChainValid)
                logger.error('StateAnchorPublisher: batch ' + round.batchSeq + ' archive will NOT reach quorum over ' +
                              'oracle_publish @ snapshot_block ' + round.cp.snapshot_block + '; on-chain v1 would be ' +
                              'invalid, rows stay pending and re-archive under a new batch seq');
            if(noTxid)
                logger.error('StateAnchorPublisher: batch ' + round.batchSeq + ' archive v1 broadcast returned no ' +
                              'txid; rows stay pending and re-archive under a new batch seq');
        }
        return { matchIds, callIds, rewardIds };
    },

    // Tell every peer the batch is spent, so a rotated leader does not re-archive it.
    announceArchiveFinalized(round, txid, ids){
        let matchIds = ids.matchIds, callIds = ids.callIds, rewardIds = ids.rewardIds;
        if(this.peerManager){
            this.peerManager.broadcast(XANC_FINALIZED, {
                batch_seq: round.batchSeq, txid: txid, matches: matchIds,
                calls: callIds,
                rewards: rewardIds,
                snapshot_block: Number(round.cp.snapshot_block),
                sig_pubkey: this.identity.getPubkeyHex().toLowerCase(),
                sig: this.identity.sign(this.finalizedCanonical(round.batchSeq, txid, matchIds.length))
            });
        }
    },

    // Log the whole archive and record the reward a complete, valid, mined publish earns.
    recordArchivePublish(round, txid, attested, attestSigs){
        logger.info('StateAnchorPublisher: archived ' + round.count + ' matches + ' +
                    ((round.callIds && round.callIds.length) || 0) + ' calls + ' +
                    ((round.rewardIds && round.rewardIds.length) || 0) + ' rewards (batch ' + round.batchSeq +
                    ', ' + round.chunks.length + ' chunk(s), txid ' + txid + ')');
        // At/above the archive-reward flag-day the reward is DERIVED on-chain from the
        // v1 publisher attestation, and the indexer credits NOTHING for a v1 whose
        // ATTEST_SIG_COUNT is 0. Recording it anyway would strand the credit in
        // hub-local + archive bookkeeping only, forking the COLLECT rail
        // live-vs-recovered (same reasoning as the v0 degraded-fallback withhold).
        if(attested || !ar.isArchiveRewardActive(Number(round.cp.snapshot_block), round.cp.network)){
            this.recordReward('anchor_archive', round.batchSeq,
                               this.identity ? this.identity.getPubkeyHex() : null,
                               Number(round.cp.snapshot_block), round.cp.network);
            // Option C: mirror the archive XANCPUB quorum so the BTC indexer derives
            // the anchor_archive reward (only when the attestation tail actually landed).
            // Same confirm-then-write rule as the v0 bundle site. onChainValid above
            // is a signature-quorum verdict, not proof the v1 head was mined, and `txid` is
            // the mempool txid broadcastWithRetry returned, so the row is queued until the
            // head is buried at version 1.
            if(attested){
                let mePk = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
                if(mePk)
                    this.deferRewardAttestation({
                        chain: round.cp.chain, network: round.cp.network,
                        blockIndex: Number(round.cp.block_index), checkpointSeq: Number(round.cp.checkpoint_seq),
                        txid: txid, anchorVersion: 1,
                        rewardType: 'anchor_archive', roundReference: Number(round.batchSeq),
                        snapshotBlock: Number(round.cp.snapshot_block),
                        publisher: mePk, attestSigs: attestSigs,
                        federate: true      // archive leader owns the fan-out, same as the v0 bundle site
                    });
            }
        } else {
            logger.info('StateAnchorPublisher: degraded v1 archive (ATTEST_SIG_COUNT 0) at/above the ' +
                        'archive-reward flag-day for batch ' + round.batchSeq +
                        '; reward withheld (no live indexer derives it)');
        }
    }

};
