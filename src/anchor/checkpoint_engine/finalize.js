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
 * State checkpoint engine - finalized checkpoints
 *
 * Every hub verifies a finalized signature set and writes its own row, behind the
 * rootless refusal and the same-sequence conflict fence.
 *
 ********************************************************************/

'use strict';

const canonicalForms    = require('./canonical_forms.js');
const ValidatorIdentity = require('../../validators/identity.js');
const swq               = require('../../stake_weighted_quorum.js');
const { bftQuorumOrSingle } = require('../../lib/bft_quorum.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Every hub verifies + writes the finalized checkpoint locally (the mirror
    // streams from each hub to ITS OWN indexer subscribers, so everyone writes).
    async handleFinalized(envelope){
        let d  = envelope.data;
        let cp = this.normalizeCheckpoint(d.checkpoint);
        if(!cp || !Array.isArray(d.signatures)){
            this._malformedFinalized++;
            logger.warn('StateCheckpointEngine: dropped malformed FINALIZED broadcast (missing checkpoint or signatures array)');
            return;
        }

        // A finalized checkpoint whose seq is not the value derived from its
        // snapshot_block is malformed (the signers would not have co-signed it); refuse
        // to persist it even with an otherwise-valid signature set.
        if(Number(cp.checkpoint_seq) !== canonicalForms.deriveCheckpointSeq(cp.snapshot_block)){
            this._malformedFinalized++;
            logger.warn('StateCheckpointEngine: dropped FINALIZED with seq ' + cp.checkpoint_seq +
                ' != derived seq for snapshot_block ' + cp.snapshot_block);
            return;
        }

        let validators = await this.resolveCapabilityValidators('oracle_publish', cp.snapshot_block);
        let pubkeys    = new Set(validators.map(v => String(v.pubkey).toLowerCase()));   // signer-membership set
        // Size the quorum from the RAW row count (item 2651), matching the propose
        // path (runRound) and the on-chain authority (anchor.js:336). The deduped
        // pubkeys.size used before diverged whenever a key was multi-source. `quorum` only
        // gates the count path (weighted uses meetsStakeThreshold), and below SWQ
        // validators.length == pubkeys.size, so this is inert below SWQ.
        let snapCount  = validators.length;
        let weighted   = swq.isStakeWeightedQuorumActive(cp.snapshot_block, this.network);
        let quorum     = bftQuorumOrSingle(snapCount, 1);   // majority-floored BFT quorum

        let canonical = canonicalForms.canonicalCheckpoint(cp);
        let seen = new Set(), sigs = [];
        for(let s of d.signatures){
            let pk = String(s && s.pubkey || '').toLowerCase();
            if(!pk || seen.has(pk) || !pubkeys.has(pk)) continue;
            if(!ValidatorIdentity.verify(canonical, String(s.sig || ''), pk)) continue;
            seen.add(pk);
            sigs.push({ pubkey: pk, sig: String(s.sig) });
        }
        let met = weighted
            ? swq.meetsStakeThreshold(validators, sigs.map(s => s.pubkey))
            : (sigs.length >= quorum);
        if(!met){                                                  // sub-quorum, ignore
            this._subQuorumFinalized++;
            logger.warn('StateCheckpointEngine: dropped sub-quorum FINALIZED for snapshot_block ' + cp.snapshot_block +
                ' (' + sigs.length + '/' + quorum + ' valid sigs' + (weighted ? ', stake-weighted' : '') +
                '); persisted nothing on this hub');
            return;
        }
        await this.acceptFinalized(cp, sigs, quorum, false);
    },

    // Write the checkpoint row (append-only INSERT IGNORE: a reorged height is
    // superseded by a NEW row with a higher checkpoint_seq, never an UPDATE, so
    // the INSERT-IGNORE indexer mirror always converges), stream it to our
    // indexer subscribers, and emit for the StateAnchorPublisher.
    async acceptFinalized(cp, sigs, quorum, isLeader){
        // Refuse BEFORE any work. This cp arrived from a PEER, so its network is
        // the sender's claim; if it disagrees with ours we would tally the signature set
        // under a different rule than the anchor publisher (and the sender) will. Checked
        // first so a cross-network checkpoint costs no validator resolution and cannot
        // slip past an earlier early-return.
        this.assertCheckpointNetwork(cp, 'accept-finalized');
        // EVERY hub persists the oracle_publish snapshot for the checkpoint's
        // snapshot_block, not just the cadence leader (_tick): ANCHOR verifiers
        // check the checkpoint's signatures against capability_snapshots in
        // whichever hub DB they mirror, and a follower's DB may be the only one
        // they read. Deterministic from BTC stakes + INSERT IGNORE, so all hubs
        // write identical rows. Persisted BEFORE the checkpoint row streams so a
        // mirror subscriber never sees a row it can't verify: a persist failure
        // must therefore fail closed (throw) rather than log-and-continue, so the
        // checkpoint INSERT/broadcast/emit below are all skipped and no
        // quorum-signed, unverifiable row reaches a mirror or the anchor poller.
        // Matches the leader _tick persist (unguarded) and writeFinalizedMatch;
        // callers (_tick .catch, handleFinalized .catch, the leader accept .catch)
        // log the accept error, and the FINALIZED broadcast is re-deliverable.
        this.refuseRootlessPersist(cp);

        let seated = await this.seatedCheckpointAtSeq(cp);
        if(this.reportSeqConflict(seated, cp, sigs)) return;

        await this._persistCapabilitySnapshot('oracle_publish', Number(cp.snapshot_block));
        await this.db.createStateCheckpoint(cp.chain, cp.network, cp.block_index, cp.block_hash, cp.ledger_hash, cp.actions_hash, cp.contract_hash, cp.checkpoint_seq, cp.snapshot_block, cp.state_root || null, cp.state_root_version != null ? cp.state_root_version : null, cp.block_merkle_root || null, cp.block_merkle_version != null ? cp.block_merkle_version : null, JSON.stringify(sigs));

        await this.broadcastRowOrResync(
            'state_checkpoints',
            () => this.db.getStateCheckpointByChain(cp.chain, cp.network, cp.block_index, cp.checkpoint_seq),
            'state-checkpoint broadcast gap');

        this.advanceLatchAndEmit(cp, sigs, quorum, isLeader);
    },

    // Final backstop. Co-sign now refuses a rootless checkpoint, but this
    // path also accepts checkpoints that arrive already-finalized from a peer, so it
    // must enforce the rule independently rather than trust that every signer did.
    //
    // Placed BEFORE the capability-snapshot persist below on purpose: that persist is
    // deliberately fail-closed so "no quorum-signed, unverifiable row reaches a mirror
    // or the anchor poller", and the same reasoning applies one step earlier. Throwing
    // here means neither the snapshot nor the checkpoint row is written and nothing is
    // broadcast or emitted; the caller's .catch logs the accept error and the FINALIZED
    // broadcast stays re-deliverable.
    refuseRootlessPersist(cp){
        if(canonicalForms.isRootless(cp))
            throw new Error('refusing to persist rootless checkpoint ' + cp.chain + '@' + cp.block_index +
                ': checkpoint-commitment is active for snapshot_block ' + cp.snapshot_block +
                ' but the light-client roots are absent');
    },

    // Same-seq conflict fence. uq_chain_seq admits exactly ONE row per
    // (chain, network, checkpoint_seq), so a second, DIFFERENT payload at a seated
    // sequence is dropped by the INSERT IGNORE below with no trace of why: the
    // read-back then finds nothing, dumps every mirror subscriber for a resync that
    // cannot repair it, advances the cadence latch and emits a checkpoint this hub
    // does not hold. Two hubs that received the two FINALIZED broadcasts in opposite
    // orders keep DIFFERENT checkpoints at that sequence, permanently and silently.
    // Refuse and say so instead. This is DETECTION, not prevention: nothing here
    // stops a Byzantine cadence leader collecting quorum on two payloads at one
    // sequence (co-sign bounds every field derived from snapshot_block but leaves
    // block_index free, and _roundId's block_index puts the two proposals in
    // different rounds), so a divergence can still form across hubs. It becomes
    // diagnosable rather than invisible.
    //
    // Compared FIELD-WISE and not by rebuilding a canonical from the seated row:
    // cpFromRow deliberately carries no light-client roots, so a canonical rebuilt
    // through it is rootless on one side only and would read every ordinary
    // post-flag-day re-delivery as a conflict. The roots are themselves derived from
    // the block, so the four chained hashes plus block_index settle identity.
    // True when `seated` names a different payload (metered and logged), so the caller
    // persists, streams and emits nothing.
    reportSeqConflict(seated, cp, sigs){
        if(seated && canonicalForms.checkpointRowDiffers(seated, cp)){
            this._seqConflicts++;
            logger.error('StateCheckpointEngine: CONFLICTING checkpoint at ' + cp.chain + '/' + cp.network +
                          ' seq ' + cp.checkpoint_seq + ': we hold block ' + Number(seated.block_index) +
                          ' (' + String(seated.block_hash) + '), this FINALIZED carries block ' +
                          Number(cp.block_index) + ' (' + String(cp.block_hash) + '). Both were quorum-signed, ' +
                          'so the federation equivocated at one sequence; persisting nothing, streaming ' +
                          'nothing and emitting nothing on this hub. Held signature set: ' +
                          JSON.stringify(sigs));
            return true;
        }
        return false;
    },

    // Advance the cadence latch for PEER-led rounds too, symmetric with the
    // startup seed (loadLastCheckpointLatch reads MAX(snapshot_block) over rows
    // written by ANY leader). Writing it only in the leader branch of _tick left
    // each hub gated on its own leadership history: with N validators and leader
    // = btcBlock % N, every hub's latch is stale on the N-1 blocks it does not
    // lead, so the federation finalizes a round roughly every intervalBlocks / N
    // blocks. That advances checkpoint_seq (and therefore ANCHOR_CHECKPOINT_EVERY_N,
    // which is defined against seq % N) N times faster than CHECKPOINT_INTERVAL_BLOCKS
    // configures, and burns DOGE on the extra anchors. Monotonic so an out-of-order
    // or replayed FINALIZED cannot walk the latch backwards into an early round.
    advanceLatchAndEmit(cp, sigs, quorum, isLeader){
        let latch = Number(cp.snapshot_block);
        if(Number.isFinite(latch) && (this._lastCheckpointBtcBlock == null || latch > this._lastCheckpointBtcBlock))
            this._lastCheckpointBtcBlock = latch;

        logger.info('StateCheckpointEngine: checkpoint ' + cp.chain + '/' + cp.network + ' @ ' + cp.block_index +
                    ' seq ' + cp.checkpoint_seq + ' (' + sigs.length + '/' + quorum + ' sigs' + (isLeader ? ', leader' : '') + ')');
        this.emit('checkpoint:finalized', { checkpoint: cp, signatures: sigs });
    },

    // The one row uq_chain_seq already admitted at this (chain, network, seq), or null.
    // Keyed on the UNIQUE index and NOT on block_index, unlike the mirror read-back:
    // the whole point is to see the row a different block_index seated.
    // Fails OPEN on a read error, deliberately. uq_chain_seq is the safety property and
    // it holds with or without this read; the fence only decides whether the loser is
    // DIAGNOSED or dropped silently. Throwing here would turn a transient DB blip into a
    // refusal to persist quorum-signed checkpoints, which is strictly worse than the
    // divergence it is watching for (StateCheckpointEngine.broadcast-gap pins that a DB
    // fault on this table must still leave the commit, the latch and the emit intact).
    async seatedCheckpointAtSeq(cp){
        let r;
        try {
            r = await this.db.getStateCheckpointByChainAndNetworkAndCheckpointSeq(cp.chain, cp.network, Number(cp.checkpoint_seq));
        } catch(e){
            logger.warn('StateCheckpointEngine: same-seq conflict check could not read ' + cp.chain + '/' +
                         cp.network + ' seq ' + cp.checkpoint_seq + ' (' + (e && e.message) +
                         '); the unique key still admits one row, but a conflict would go unreported');
            return null;
        }
        return (r && r.length > 0) ? r[0] : null;
    }

};
