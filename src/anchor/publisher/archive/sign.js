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
 * ANCHOR publisher - archive co-signing
 *
 * The follower side of an archive round: verify the proposal against our own
 * rows before co-signing, collect the signatures, and refuse a consumed seq.
 *
 ********************************************************************/

'use strict';

const canonicalForms = require('../canonical_forms.js');
const zlib = require('zlib');
const ValidatorIdentity = require('../../../validators/identity.js');
const StateCheckpointEngine = require('../../checkpoint_engine.js');
const swq = require('../../../stake_weighted_quorum.js');
const { XANC_SIGN } = require('../constants.js');
const { getLogger } = require('../../../observability');
const logger = getLogger();

module.exports = {

    // Follower: co-sign ONLY an archive that byte-matches our own DB state.
    async handleSignReq(envelope){
        let d = envelope.data;
        if(!this.identity || !d || !d.checkpoint) return;
        let myPubkey = this.identity.getPubkeyHex().toLowerCase();
        let sender   = String(d.sig_pubkey || '').toLowerCase();
        if(sender === myPubkey) return;

        let cp = d.checkpoint;
        // The publisher is elected by the CURRENT BTC block (not the checkpoint's
        // possibly hours-old snapshot_block). The REQ carries its election block;
        // we verify the SENDER's rank against it, bounded to our own view of the
        // BTC tip (anti-spam; the security property is the DB byte-match below).
        let electionBlock = Number(d.election_block);
        if(!Number.isFinite(electionBlock)) return;
        let myBtc = this.hub.resolveBtcLatestBlock ? await this.hub.resolveBtcLatestBlock() : null;
        if(Number.isFinite(myBtc) && Math.abs(myBtc - electionBlock) > this.electionToleranceBlocks) return;
        let electionPubkeys = await this.getActiveOraclePublishPubkeys(electionBlock);
        if(!this.archiveSenderUnlocked(electionPubkeys, cp, sender, electionBlock)) return;
        let canonical = this.verifiedArchiveCanonical(d, cp, sender);
        if(canonical === null) return;
        let myNextSeq = await this.getNextBatchSeq();
        if(this.refusedStaleArchiveSeq(d, sender, myNextSeq)) return;
        this.bindObservedArchiveLeader(d, sender, cp, electionPubkeys);
        // MY co-sign eligibility, by contrast, is gated on the snapshot_block
        // SIGNING set: the indexer + recovery only count a wrapper signature whose
        // signer holds oracle_publish AT snapshot_block, so a follower present only
        // in the current election set would contribute a signature that is dropped
        // on-chain and could drag an otherwise-valid archive below quorum.
        let signingPubkeys = await this.getActiveOraclePublishPubkeys(Number(cp.snapshot_block));
        if(!signingPubkeys.includes(myPubkey)) return;

        // 1. The checkpoint wrapper must equal OUR state_checkpoints row (latest
        // seq for the height; a reorg-superseded row never co-signs an archive).
        let local = await this.db.getStateCheckpointByChainAndNetwork(cp.chain, cp.network, Number(cp.block_index));
        let mine = this.ownArchiveWrapper(local, cp);
        if(!mine) return;

        // 2. The archive must decompress, CRC-match, and byte-match our own rows.
        let archive = this.decodeArchiveProposal(d);
        if(!archive) return;
        // Wrapper snapshot_block from OUR OWN row (`mine`), never the archive body: it
        // decides which oracle_publish group the completeness check requires, and `mine`
        // is byte-matched to the wire cp above (snapshot_block rides rawCanonicalCheckpoint).
        if(!(await this.verifyArchiveAgainstLocal(archive, Number(mine.snapshot_block)))){
            logger.warn('StateAnchorPublisher: proposed archive (batch ' + d.batch_seq + ') diverges from our DB; NOT signing');
            return;
        }
        this.coSignArchive(d, sender, archive, canonical, myPubkey);
    },

    // Fail CLOSED on an unresolved election set, the same way the LEADER does
    // at the identical condition (startArchiveRound: "empty oracle_publish set,
    // deferring round (fail closed)") and the same way handleFinalized and
    // handleBundleDone already do. The old fall-through skipped BOTH the rank ladder and
    // every membership tie to the federation, so during an unresolved window a
    // NON-MEMBER could solicit co-signatures from the historical wrapper set and
    // assemble a duplicate v1 under a batch_seq of its own choosing: honest CONTENT
    // (the DB byte-match still holds) but real DOGE burned twice, and two archives
    // able to claim one seq, which is what the ladder exists to serialize.
    // The liveness the asymmetry protected is nearly nil: the snapshot_block
    // signing-set gate in handleSignReq already returns on an empty answer from THIS
    // SAME resolver, so an indexer outage that empties the election set almost always
    // empties the signing set too and this hub was not going to co-sign either way.
    // The residual case (electionBlock unresolvable while snapshot_block is cached)
    // costs one co-signature on one round, which the round timeout re-runs.
    archiveSenderUnlocked(electionPubkeys, cp, sender, electionBlock){
        if(electionPubkeys.length === 0) return false;
        {
            // Same wrapper-anchored key + failover ladder the leader used. Keyed on the
            // WIRE checkpoint only: the wire batch_seq no longer reaches the key, so a
            // verifier whose own batch numbering has drifted from the proposer's still
            // derives the identical rank order.
            // Accept any sender whose rank has unlocked, not just rank 0, or a
            // signer-less rank-0 hub stalls archiving federation-wide.
            // Runs for a single-member set too, so the
            // sole elected leader cannot be impersonated by a non-member.
            let order = canonicalForms.hashOrder(this.archiveElectionKey(cp), electionPubkeys);
            let since = electionBlock - Number(cp.snapshot_block);
            if(!this.rankUnlocked(order, sender, since)) return false;      // not unlocked on the failover ladder
        }
        return true;
    },

    // AUTHENTICATE THE PROPOSER BEFORE BINDING ANYTHING TO IT. Everything handleSignReq
    // checked before this is derived from the wire: `sender` is the application-level
    // d.sig_pubkey, NOT the envelope key PeerManager authenticated (that one binds
    // only the relayer), and the rank ladder is keyed on the wire checkpoint, so any
    // federation member can put another member's pubkey here and unlock a rank by
    // choosing cp/batch_seq. The proposer's signature over the archive canonical is
    // the one thing only the real leader can produce, so it gates the record: without
    // it, a member could poison _observedArchiveCheckpoints for a future batch_seq
    // (first observation wins, so the genuine round then resolves no local row and
    // never co-signs) or flood past _observedArchiveLeadersCap and evict the
    // in-flight entries every legitimate XANC_FINALIZED is authenticated against.
    // The canonical is built from wire fields already in hand, so verifying here
    // costs no extra state and no liveness.
    // Hands back the canonical the proposer signed, or null when its signature fails.
    verifiedArchiveCanonical(d, cp, sender){
        let canonical = this.archiveCanonical(cp, Number(d.batch_seq), Number(d.match_count),
                                               String(d.batch_crc32), Number(d.total_chunks));
        if(!ValidatorIdentity.verify(canonical, String(d.sig || ''), sender)) return null;
        return canonical;
    },

    // Stale-seq convergence, the receiving half. The election key no longer carries a batch_seq, so
    // a proposer whose seq is stale now reaches us as a correctly-elected leader
    // asking us to co-sign a seq we already hold as CONSUMED (its rows are archived
    // in our tables; the proposer missed that back-fill). Co-signing would put a
    // second v1 head on DOGE under a number that is already taken, which corrupts
    // chunk reassembly for both batches. Refuse, and say so on the wire so the
    // proposer can converge instead of re-proposing the same stale seq every flush.
    //
    // Placed BEFORE recordObservedArchiveLeader on purpose: recording it would
    // authorize this leader's FINALIZED to stamp our rows under the stale seq.
    // Refusing costs no liveness - the proposer re-derives above our seq and comes
    // back - and a hub that is genuinely BEHIND (its next seq is at or below the
    // proposal) never takes this branch.
    // True when the refusal went out, so handleSignReq stops there.
    refusedStaleArchiveSeq(d, sender, myNextSeq){
        if(Number(d.batch_seq) < myNextSeq){
            let consumed = myNextSeq - 1;
            logger.warn('StateAnchorPublisher: refusing to co-sign archive batch ' + Number(d.batch_seq) +
                         ' from ' + sender.substring(0, 12) + '...: this hub already holds batch seq ' +
                         consumed + ' as consumed (our next seq is ' + myNextSeq + '), so the proposer is ' +
                         'behind on the archive back-fill; answering with a stale-seq refusal');
            this.broadcastSeqRefusal(Number(d.batch_seq), consumed);
            return true;
        }
        return false;
    },

    // The sender has validated as the (rank-unlocked) elected archive leader
    // for this batch_seq at election_block. Bind it locally BEFORE the
    // snapshot-set co-sign check in handleSignReq, so an election-set member that will
    // NOT co-sign (present only at election_block, not at snapshot_block) can
    // still authenticate this leader's later XANC_FINALIZED and back-fill.
    // Deliberately still ahead of the local state_checkpoints byte-match there: a
    // hub lagging on the wrapper checkpoint must keep recording the leader, or it
    // abstains from the back-fill and the rows re-archive under a fresh seq.
    bindObservedArchiveLeader(d, sender, cp, electionPubkeys){
        if(electionPubkeys.includes(sender))
            this.recordObservedArchiveLeader(Number(d.batch_seq), sender, cp);
    },

    // Our own row for the archive's wrapper checkpoint, or null when we hold none or it
    // names a different checkpoint.
    ownArchiveWrapper(local, cp){
        if(!local || local.length === 0) return null;
        let mine = this.cpFromRow(local[0]);
        // Rootless compare, deliberately: archiveCanonical nests
        // rawCanonicalCheckpoint by construction and cpFromRow omits the SPV root
        // fields, so this guard binds identity fields only. Pinning to
        // rawCanonicalCheckpoint keeps it immune to the presence-gated root suffix.
        if(StateCheckpointEngine.rawCanonicalCheckpoint(mine) !== StateCheckpointEngine.rawCanonicalCheckpoint(cp)) return null;
        return mine;
    },

    // The proposed archive body, or null when it does not decompress, CRC-match, parse, or
    // carry the announced match count.
    decodeArchiveProposal(d){
        let json;
        // Bounded decompress: the archive is attacker-supplied bytes decompressed
        // BEFORE any CRC/quorum check, so an unbounded gunzip is a gzip-bomb DoS.
        // Mirror the committed indexer cap (anchor.js / recovery.js, 16 MiB).
        try { json = zlib.gunzipSync(Buffer.from(String(d.archive_b64), 'base64url'), { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8'); }
        catch(e){ return null; }
        if(this.crc32Hex(json) !== String(d.batch_crc32)) return null;
        let archive;
        try { archive = JSON.parse(json); } catch(e){ return null; }
        if(!archive || !Array.isArray(archive.matches) || archive.matches.length !== Number(d.match_count)) return null;
        return archive;
    },

    // The body byte-matches our own rows, so its membership is the authority on which
    // rows this batch may later mark archived. Record it BEFORE co-signing: the
    // signature about to go out is part of what carries this exact archive to DOGE,
    // and the FINALIZED that closes the round is checked against it.
    coSignArchive(d, sender, archive, canonical, myPubkey){
        this.recordObservedArchiveContent(Number(d.batch_seq), sender, archive);

        this.peerManager.broadcast(XANC_SIGN, {
            batch_seq: Number(d.batch_seq), sig_pubkey: myPubkey, sig: this.identity.sign(canonical)
        });
    },

    // Answer a SIGN_REQ we refuse on stale-seq grounds. Deliberately rides the EXISTING
    // XANC_SIGN message as optional fields (`consumed_seq` + `refusal_sig`, with `sig`
    // empty) rather than introducing a new p2p type: an un-upgraded leader runs this
    // through handleSign's `ValidatorIdentity.verify(round.canonical, '')`, which is
    // false, so it drops the message exactly as it drops any other unusable co-signature.
    // The refusal is signed because it can abandon a live round: unsigned, any peer could
    // stall archiving federation-wide.
    broadcastSeqRefusal(batchSeq, consumedSeq){
        if(!this.peerManager || !this.identity) return;
        this.peerManager.broadcast(XANC_SIGN, {
            batch_seq: Number(batchSeq),
            sig_pubkey: this.identity.getPubkeyHex().toLowerCase(),
            sig: '',
            consumed_seq: Number(consumedSeq),
            refusal_sig: this.identity.sign(this.seqRefusalCanonical(Number(batchSeq), Number(consumedSeq)))
        });
    },

    async handleSign(envelope){
        let d = envelope.data;
        let round = this._archiveRound;
        if(!round || round.done || Number(d.batch_seq) !== round.batchSeq) return;
        let pubkey = String(d.sig_pubkey || '').toLowerCase();
        // Stale-seq convergence, the proposing half. A follower that already holds this
        // round's seq as consumed answers with a stale-seq refusal instead of a
        // signature. Learn the floor from it and ABANDON the round: rebuilding the same
        // batch under the same stale seq every flush is what left the federation stuck
        // (hub0 batch 38 / hub1 batch 39, neither publishing). Rows stay pending and the
        // next flush draws above the floor.
        //
        // Authenticated against the oracle_publish set at THIS round's own election
        // block (the same population that elected the round) plus a signature over the
        // refusal canonical, and only a refusal naming a seq at or above ours can move
        // anything, so a member cannot walk our numbering backwards or forwards at will.
        if(d.consumed_seq !== undefined && d.consumed_seq !== null){
            if(Number(d.consumed_seq) < round.batchSeq) return;
            let electionPubkeys = await this.getActiveOraclePublishPubkeys(round.electionBlock);
            if(!electionPubkeys.includes(pubkey)) return;
            if(!ValidatorIdentity.verify(this.seqRefusalCanonical(round.batchSeq, Number(d.consumed_seq)),
                                         String(d.refusal_sig || ''), pubkey)) return;
            logger.warn('StateAnchorPublisher: archive round (batch ' + round.batchSeq + ') refused by ' +
                         pubkey.substring(0, 12) + '..., which holds batch seq ' + Number(d.consumed_seq) +
                         ' as consumed; abandoning the round rather than publishing a second archive under ' +
                         'seq ' + round.batchSeq + ' (rows stay pending and re-archive above the learned seq)');
            this.noteConsumedBatchSeq(Number(d.consumed_seq), 'co-sign refusal from ' + pubkey.substring(0, 12) + '...');
            round.done = true;
            if(round.timer){ clearTimeout(round.timer); round.timer = null; }
            if(this._archiveRound === round) this._archiveRound = null;
            return;
        }
        if(!round.validators.some(v => v.pubkey === pubkey)) return;
        if(!ValidatorIdentity.verify(round.canonical, String(d.sig || ''), pubkey)) return;
        round.signatures.set(pubkey, String(d.sig));
        await this.checkArchiveQuorum();
    },

    async checkArchiveQuorum(){
        let round = this._archiveRound;
        if(!round || round.done) return;
        // STAKE_WEIGHTED_QUORUM: fire on distinct-source signer stake > 2/3 of the
        // snapshot when weighted, else legacy signature count. Matches the indexer
        // anchor.js / recovery verdict so the publisher never dequeues a batch the
        // chain then rejects (or stalls a stake-met-but-count-short batch).
        let met = round.weighted
            ? swq.meetsStakeThreshold(round.validators, round.signatures.keys())
            : (round.signatures.size >= round.quorum);
        if(!met) return;
        round.done = true;
        if(round.timer){ clearTimeout(round.timer); round.timer = null; }
        // Hand the guard over BEFORE releasing _archiveRound, so no window exists in
        // which neither field is set. This runs from handleSign, outside flush()'s
        // mutex, and the publish below awaits a peer round wide enough for several
        // flush ticks to fire inside it.
        this._archivePublishing = round;
        this._archiveRound = null;
        // Same rule as the single-node path: a round held by a surviving broadcast
        // intent published nothing, so the pending counter stays as it was.
        let result;
        try {
            result = await this.publishArchive(round);
        } finally {
            this._archivePublishing = null;
        }
        if(result !== 'intent_held') this._pendingMatches = 0;
    }

};
