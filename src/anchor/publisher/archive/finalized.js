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
 * ANCHOR publisher - FINALIZED intake
 *
 * A peer's archive announcement, authenticated against the round we observed and
 * against the head's own burial depth before anything is stamped.
 *
 ********************************************************************/

'use strict';

const ValidatorIdentity = require('../../../validators/identity.js');
const { getLogger } = require('../../../observability');
const logger = getLogger();

module.exports = {

    // Back-fills batch metadata from the archive leader so a rotated leader doesn't re-archive.
    async handleFinalized(envelope){
        let d = envelope.data;
        if(!d || !Array.isArray(d.matches)) return;
        let sender = String(d.sig_pubkey || '').toLowerCase();
        let pubkeys = await this.getActiveOraclePublishPubkeys(null);
        // Fail CLOSED on an empty set (see handleBundleDone): membership is the only tie
        // to a federation member, so an empty set must reject. Otherwise a forged
        // FINALIZED backfills real matches as archived and strands them for recovery.
        if(pubkeys.length === 0 || !pubkeys.includes(sender)) return;
        if(!ValidatorIdentity.verify(this.finalizedCanonical(Number(d.batch_seq), d.txid, d.matches.length),
                                     String(d.sig || ''), sender)) return;
        // batch_seq is bound into the canonical just verified and the sender is
        // an oracle_publish member, so this is authenticated evidence that the seq is
        // spent. Learn it HERE, ahead of the observed-leader gate below: a hub that
        // missed the SIGN_REQ (the very hub most likely to be behind) is rejected by that
        // gate and would otherwise learn nothing, then draw the taken seq on its own next
        // round. Recording the floor stamps no rows, so it cannot suppress anything.
        this.noteConsumedBatchSeq(Number(d.batch_seq), 'XANC_FINALIZED from ' + sender.substring(0, 12) + '...');
        // Authenticate the FINALIZED sender as an archive leader we actually
        // observed getting elected for THIS batch_seq (via handleSignReq). The
        // archive election is keyed on election_block, which the FINALIZED
        // canonical does NOT carry, so membership + signature alone let ANY
        // oracle_publish member forge a FINALIZED that (a) marks settled rows
        // archived under a bogus batch_seq -> stranded from full-parse recovery
        // (XANC-FINALIZED-STRAND-1), and (b) mirrors the anchor_archive reward
        // crediting itself -> mints COLLECT-spendable XCHAIN, since the archive
        // reward push is NOT retired by the anchor-reward flag-day (RewardTracker
        // only derives anchor_<CHAIN> on-chain; anchor_archive still pushes). Fail
        // closed on an un-observed round: back-fill is local bookkeeping the rows
        // re-archive under a fresh seq if missed, and the elected leader records
        // its own reward directly (co-signers' mirrors are redundant, INSERT
        // IGNORE-deduped). A Byzantine ELECTED leader announcing a never-published
        // txid is the residual, closable only by on-chain DOGE txid verification.
        if(!this.isObservedArchiveLeader(Number(d.batch_seq), sender)) return;
        // XANC-FINALIZED-CONTENT-1: the signed canonical binds only (batch_seq,
        // txid, match COUNT); the match/call/reward id+status lists are UNSIGNED
        // wire fields. The observed-leader gate above bounds WHO may send this,
        // not WHAT it says: a Byzantine ELECTED leader could otherwise stamp
        // arbitrary local rows archived with attacker-chosen statuses, stranding
        // them from every future archive round. Re-verify the announced content
        // against OUR OWN rows before stamping (receiver-side only, no
        // wire-format change; same authority argument as verifyArchiveAgainstLocal:
        // every hub writes finalized rows, so the local DB is authoritative).
        // Rejecting is always safe: back-fill is local bookkeeping and missed
        // rows simply re-archive under a fresh batch seq.
        let calls   = Array.isArray(d.calls)   ? d.calls   : [];
        let rewards = Array.isArray(d.rewards) ? d.rewards : [];
        if(!(await this.verifyFinalizedAgainstLocal(d.matches, calls, rewards))){
            logger.warn('StateAnchorPublisher: FINALIZED (batch ' + d.batch_seq + ') announces content ' +
                         'diverging from our DB; ignoring back-fill (rows re-archive under a fresh seq)');
            return;
        }
        if(this.finalizedCarriesStrayRows(d, sender, calls, rewards)) return;
        if(this.finalizedNullTxidForged(d, calls, rewards)) return;
        await this.stageFinalizedBackfill(d, sender, calls, rewards);
    },

    // XANC-FINALIZED-MEMBER-1. The content check in handleFinalized asks only that each announced row
    // exist locally at the announced status, and the XANCFIN canonical commits to the
    // match COUNT, never to WHICH rows. An elected leader can therefore archive a
    // handful of rows and announce hundreds of other real, correctly-statused ones:
    // the back-fill stamps archived_status = status on every one, and the pending
    // selectors (`batch_seq IS NULL OR archived_status <> status`) then skip a
    // TERMINAL row forever, so rows no archive on DOGE ever carried are suppressed
    // and unreachable to full-parse recovery. Hold the announcement to the archive
    // body this hub decompressed and byte-verified for its co-sign. An honest leader
    // announces exactly round.matchIds, the same array buildArchive serialized, so
    // this costs no liveness; a stray row leaves the WHOLE back-fill unstamped and
    // the rows re-archive under a fresh seq.
    //
    // A hub that never parsed a body for this (batch_seq, proposer) abstains, so the
    // gate binds the co-signers rather than every listener. Closing the residual (the
    // co-signed body is the one that reached DOGE) needs the archive head's crc32 and
    // match_count read back from an author-agnostic getarchiveanchor, which today
    // scopes its lookup to the CALLER's own DOGE address and so cannot answer for a
    // peer's head.
    // True when the announcement names a row the archive this hub co-signed does not carry.
    finalizedCarriesStrayRows(d, sender, calls, rewards){
        let stray = this.finalizedOutsideObservedArchive(Number(d.batch_seq), sender, d.matches, calls, rewards);
        if(stray){
            logger.warn('StateAnchorPublisher: FINALIZED (batch ' + d.batch_seq + ') announces ' + stray +
                         ', which the archive we co-signed for this batch does not carry; ignoring the ' +
                         'back-fill (rows stay pending and re-archive under a fresh seq)');
            return true;
        }
        return false;
    },

    // XANC-FINALIZED-NULLTXID-1. The back-fill in stageFinalizedBackfill is
    // state-changing and runs before ANY on-chain check: it stamps
    // archived_status = status, and the pending selectors
    // (`batch_seq IS NULL OR archived_status <> status`) then skip those rows, which
    // for a row already at its TERMINAL status means forever. An elected-yet-
    // Byzantine leader that announces real pending rows carrying their true current
    // statuses passes verifyFinalizedAgainstLocal (the statuses genuinely match) and
    // can suppress them with an archive it never published.
    //
    // An honest leader NEVER emits that shape: publishArchive rewrites every match
    // and call status to the '__partial__' sentinel and clears the reward list
    // whenever the broadcast returned no txid, so `txid == null` implies
    // `every status === '__partial__'`, which leaves `archived_status <> status` and
    // keeps the rows eligible. Refuse the combination the honest builder cannot
    // produce. This costs no liveness at all and needs no chain access, but it closes
    // only the NULL-txid half: a FABRICATED-but-plausible txid still stamps, and
    // closing that needs the announced txid verified on DOGE at depth. That gate
    // cannot simply be inlined here - the FINALIZED is broadcast at 0 confirmations
    // (mempool) exactly like XANC_BUNDLE_DONE, so it needs the same defer-and-re-verify
    // queue (deferBundleDone / drainDeferredBundleDone), plus an archive-head version SET
    // {1, 6} in verifyArchiveCheckpointOnChain, which today hardcodes v1 because it
    // only runs below the flag-day.
    // True when the announcement pairs no txid with rows no honest failed publish produces.
    finalizedNullTxidForged(d, calls, rewards){
        let terminalAnnounced = (d.matches || []).some(m => m && m.status !== '__partial__') ||
                                calls.some(c => c && c.status !== '__partial__') ||
                                rewards.length > 0;
        if(!d.txid && terminalAnnounced){
            logger.warn('StateAnchorPublisher: FINALIZED (batch ' + d.batch_seq + ') carries NO txid but ' +
                         'announces non-__partial__ rows; an honest publish marks every row __partial__ when ' +
                         'the broadcast returned no txid, so this cannot be a real archive. Ignoring the ' +
                         'back-fill (rows stay pending and re-archive under a fresh seq)');
            return true;
        }
        return false;
    },

    // XANC-FINALIZED-FORGE-1. The null-txid guard (finalizedNullTxidForged) closes
    // only the shape an honest leader cannot produce; a plausible FABRICATED txid
    // still stamps archived_status = status, which the pending selectors then skip
    // for a terminal row forever. Close it the way the v0 rail closes
    // XANC-ELECTED-FORGE-1: the announced ARCHIVE HEAD must be on DOGE at
    // dogeConfirmations depth before the suppressing column is written.
    //
    // FINALIZED is broadcast at 0 confirmations (the broadcast returns a mempool
    // txid), so 'absent'/'shallow'/'unreachable' is the NORMAL first answer for a
    // perfectly honest archive; refusing outright would be a liveness bug. Split the
    // back-fill exactly the way an honest lost-chunk publish already splits it:
    //   now   - stamp batch_seq under the '__partial__' sentinel, no txid,
    //   later - stamp the announced statuses + txid once the head is buried.
    // Staging the seq is load-bearing: getNextBatchSeq is MAX(batch_seq)+1
    // fleet-wide, so a follower that stamped nothing would hand its own next round
    // the seq the leader just used, and two v1 anchors sharing one seq corrupt chunk
    // reassembly. The sentinel keeps `archived_status <> status` true, so nothing is
    // suppressed and the rows re-archive under a fresh seq if the head never
    // confirms. Reward rows are deliberately NOT staged: their pending test is
    // `batch_seq IS NULL` alone, so an early stamp is itself permanent suppression.
    //
    // LANDING NOTE: this inverts a contract pinned OUTSIDE this repo,
    // but in ONE harness, not two, and the distinction decides what a landing lane may
    // touch. The two xchain-e2e-test suites that assert on this back-fill run under
    // OPPOSITE conditions, so a single "the harness has no chain" claim is wrong:
    //   multiHubStateAnchor.integration.test.js:282 is CHAINLESS. Its own header says
    //     "no chain in this harness" and it publishes through a captured broadcast
    //     hook, so nothing answers getanchoraction, the verify abstains, every follower
    //     stamps '__partial__', and its archived_status === 'finalized' assertion does
    //     genuinely have to move with this diff.
    //   anchorElection.test.js:412 is LIVE. Its header says "on a LIVE DOGE regtest
    //     chain" and its prerequisites boot the real indexer, which serves
    //     getanchoraction as a federation read (xchain-indexer/src/api.js:163, :1266).
    //     That repo ships no getanchoraction STUB because it has the real RPC; absence
    //     of a stub is not absence of a chain. Its assertion is therefore a live-chain
    //     assertion and must NOT be relaxed to accept '__partial__': that would delete
    //     the only coverage proving this gate stamps a REAL archive. What it actually
    //     faces is the confirmation-DEPTH question, the same one the already-landed v0
    //     gate faces at its own back-fill assertion (:283), and XANC-ELECTED-FORGE-1
    //     landed (31b7475) without editing that file.
    // One residual stays open: the gate proves the CHECKPOINT is anchored, not the
    // BATCH, since nothing binds match_batch_seq and two batch_seqs can share one
    // checkpoint. getanchoraction neither ACCEPTS it (validateAnchorActionParams takes
    // chain/network/block_index/checkpoint_seq/txid/version) nor EMITS it
    // (ANCHOR_ACTIONS_SQL selects no batch column and buildAnchorActionResponse returns
    // none), so binding it needs an xchain-indexer change before this hub can.
    async stageFinalizedBackfill(d, sender, calls, rewards){
        if(!d.txid){
            // Every announced row is '__partial__' here (finalizedNullTxidForged proves it), so
            // this is the honest failed-broadcast shape: seq bookkeeping, nothing to verify.
            await this.backfillBatch(Number(d.batch_seq), d.matches, null, calls, rewards);
            return;
        }
        // Archive-head version SET {1}: publishArchive emits a v1 head at every height,
        // attested or not (D4). This gate runs at ALL heights (row suppression has nothing
        // to do with reward retirement), so it keeps the reject-set form rather than the
        // reward gate's exact-v1 expectation. Rejecting {0,2} still stops a v0 checkpoint
        // bundle or a v2 continuation chunk standing in for the head. v0 MUST be in the
        // reject set and MUST NOT be the emitted head version: the bundle is the wire this
        // gate exists to keep out.
        let archiveOnChain = await this.verifyArchiveCheckpointOnChain(
            Number(d.batch_seq), String(d.txid), { rejectVersions: [0, 2] });
        if(archiveOnChain === 'verified'){
            await this.applyFinalized(d, sender, calls, rewards);
            return;
        }
        if(String(archiveOnChain).startsWith('rejected')){
            logger.warn('StateAnchorPublisher: FINALIZED (batch ' + d.batch_seq + ') archive head REJECTED ' +
                         'on-chain (' + archiveOnChain + '); stamping nothing (rows stay pending and ' +
                         're-archive under a fresh seq)');
            return;
        }
        await this.backfillBatch(Number(d.batch_seq),
                                  (d.matches || []).map(m => Object.assign({}, m, { status: '__partial__' })),
                                  null,
                                  calls.map(c => Object.assign({}, c, { status: '__partial__' })),
                                  []);
        this.deferFinalized(d, sender, calls, rewards, archiveOnChain);
    }

};
