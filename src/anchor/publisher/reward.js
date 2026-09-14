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
 * ANCHOR publisher - anchor rewards and their attestations
 *
 * The reward the publishing validator earns, the attestation row that lets the
 * indexer derive it from chain, and the federation wire that carries a confirmed
 * row to every peer.
 *
 ********************************************************************/

'use strict';

const { bftQuorumOrSingle } = require('../../lib/bft_quorum.js');
const { resolveQuorumNetwork } = require('../quorum_network.js');
const ValidatorIdentity = require('../../validators/identity.js');
const swq = require('../../stake_weighted_quorum.js');
const ar = require('../../anchor_reward_activation.js');
const { XANCREWARD } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Anchor-publish reward: the validator that paid the DOGE earns it. Recorded
    // on EVERY hub (by the publisher at publish time and by peers from the
    // signature-verified BUNDLE_DONE / FINALIZED announcements) with blockIndex =
    // the quorum-agreed snapshot_block of the rewarded checkpoint, so all hubs
    // hold identical row bytes and the archived rewards section verifies by
    // re-derivation. recordAnchorReward dedups all paths, including a failover
    // race that hands the same (round, type) to two different publisher pubkeys,
    // which it collapses to a single deterministic per-(round,type) winner.
    // `network` is the REWARD's network (the checkpoint row's), threaded through
    // so RewardTracker's derive-vs-push flag-day gate reads the SAME source as
    // this publisher's payload-build gate: re-deriving it from
    // this.hub.network inside RewardTracker double-credited on an unscoped hub.
    recordReward(rewardType, roundNumber, pubkey, blockIndex, network){
        if(!this.hub.rewardTracker || typeof this.hub.rewardTracker.recordAnchorReward !== 'function') return;
        if(!pubkey) return;
        this.hub.rewardTracker
            .recordAnchorReward(rewardType, roundNumber, String(pubkey).toLowerCase(), Number.isFinite(blockIndex) ? blockIndex : 0, network)
            .catch(e => logger.warn('StateAnchorPublisher: reward record failed (' + rewardType + '/' + roundNumber + '): ' + (e && e.message)));
    },

    // Option C (derive-on-BTC-side): after a v0/v1 anchor lands on-chain, publish
    // the XANCPUB publisher-attestation quorum to the append-only anchor_reward_attestations
    // table, mirrored via hub_db_sync (HUB_STATE_TABLES) to every indexer ATTACHED TO THIS HUB.
    // ANCHOR is DOGE-only but capability staking (hence the resolvable stake source
    // createValidatorReward needs) is BTC-only, so the BTC indexer keys reward derivation on
    // these rows: it re-verifies the sigs
    // against its OWN local oracle_publish set at snapshot_block (mirror = transport, not trust)
    // and materializes validator_rewards at block_index = snapshot_block. Gated by the NEW derive
    // flag-day so below the gate no rows exist (byte-identical legacy: DOGE-side write still
    // attempted + silently dropped). INSERT IGNORE keeps it idempotent on the tuple identity; a
    // failover double-publish inserts a second row and the indexer winner-reconcile collapses it.
    //
    // The mirror alone is not enough reach: HubDbSync holds ONE hubUrl
    // (xchain-indexer/src/hub/hub_db_sync.js), the row is written only on the ELECTED publisher,
    // and the publisher rotates per bundle by hashOrder, so without federation a federation's
    // hubs would hold DISJOINT subsets and an indexer would derive only the subset its own hub
    // published. So the PRODUCER federates: `e` carries the confirmed anchor txid and, on the
    // publisher, a truthy `federate`, which broadcasts XANCREWARD after the local write so
    // every peer independently re-verifies and writes its own copy. Two notes:
    //   - Do NOT "correct" the sibling sentence in src/sql/anchor_reward_attestations.sql. Its
    //     "exactly like state_checkpoints" is TRUE and scoped to the MIRROR semantics (id-parity
    //     INSERT IGNORE, never retracted); hub_db_sync.js states the identical property for both
    //     tables in HUB_STATE_TABLES. It makes no hub-to-hub federation claim, so replacing it
    //     with one would trade a true sentence for a false one on a consensus table.
    //   - The XANCPUB quorum a receiver re-verifies is the SAME quorum XANCPUB_SIGN already put
    //     on the wire, verified the same way (handleAttestSign). The receiver mints money rows,
    //     so it re-verifies against its OWN oracle_publish set at snapshot_block and re-proves
    //     the anchor mined, and never trusts the wire for either.
    // Ordering came out as the indexer's PRE-ARMING BLOCKERS note pinned it: the mined-anchor
    // proof (the deferred queue below) landed first, so federation fans out only rows whose
    // anchor this hub itself watched confirm.
    async recordRewardAttestation(chain, network, rewardType, roundReference, snapshotBlock, publisher, attestSigs, dogeAnchorTxid, e){
        if(!ar.isAnchorRewardDeriveActive(Number(snapshotBlock), network)) return;
        if(!publisher || !Array.isArray(attestSigs) || attestSigs.length === 0) return;
        let amount = (rewardType === 'anchor_archive') ? ar.ARCHIVE_REWARD_AMOUNT : ar.ANCHOR_REWARD_AMOUNT;
        // anchor_reward_attestations.chain is NOT NULL and part of uq_reward_tuple, and a
        // BUNDLE spans every chain, so the bundle row writes the ANCHOR chain 'DOGE'
        // (D21) - the archive precedent already recorded in that column's comment. The
        // `chain` argument stays the checkpoint identity the mined-anchor proof ran
        // against, so the two never get conflated.
        let rowChain = (rewardType === 'anchor_bundle') ? 'DOGE' : chain;
        let sigs   = attestSigs.map(s => ({ pubkey: String(s.pubkey).toLowerCase(), sig: String(s.sig).toLowerCase() }));
        let sigsJson = JSON.stringify(sigs);
        // The txid the drain PROVED mined for this exact tuple. Never taken from a
        // caller that did not go through that proof: a null column is a row nothing
        // downstream can prove, and the BTC indexer derives nothing from it.
        let txid = (dogeAnchorTxid == null || dogeAnchorTxid === '') ? null : String(dogeAnchorTxid).toLowerCase();
        // DURABILITY and DELIVERY are different failures and are handled differently.
        //
        // The INSERT is a precondition, so it FAILS CLOSED and propagates: the one caller
        // that queues (the deferred drain) keeps its pending entry on a throw and retries
        // under its own TTL, which is idempotent because the statement is INSERT IGNORE
        // against uq_reward_tuple. Swallowing it here logged 'row written' over a reward
        // that was never persisted and could never be re-attempted, permanently forfeiting
        // a confirmed reward on a transient DB error.
        try {
            await this.db.createAnchorRewardAttestation(rowChain, network, rewardType, roundReference, snapshotBlock, publisher, amount, sigsJson, txid);
        } catch(err){
            logger.warn('StateAnchorPublisher: anchor_reward_attestations record failed (' +
                         rewardType + '/' + roundReference + '): ' + (err && err.message));
            throw err;   // nothing to federate: peers must not be told about a row we failed to hold
        }
        // The row is now durable, so a read-back or broadcast failure must NOT fail the
        // caller or retain the queue entry: it is an undeliverable COMMITTED row, repaired
        // by forcing subscriber resync rather than retried.
        await this.broadcastRewardAttestationRow(rowChain, network, rewardType, roundReference, snapshotBlock, publisher);
        if(e && e.federate) this.federateRewardAttestation(e, sigs, txid);
    },

    // Stream an anchor_reward_attestations row this hub has ALREADY committed to hub-DB
    // mirror subscribers. Never throws: the row is durable, so a delivery failure must not
    // fail the write or block federation. A throw from the read-back and a zero-row result
    // are the same undeliverable-row event, and dropAllForResync is the sanctioned repair
    // (StateCheckpointEngine.broadcastRowOrResync and CrossChainCallEngine.mirrorCallRow
    // are the in-repo precedents, each a local copy by house convention). Without it the
    // heartbeat watermark certifies completeness past a committed attestation row an
    // attached indexer never received, and that table mints COLLECT-spendable rewards, so
    // producer and mirror end up disagreeing about reward availability.
    async broadcastRewardAttestationRow(rowChain, network, rewardType, roundReference, snapshotBlock, publisher){
        let b = this.hub && this.hub.hubDbBroadcaster;
        if(!b || typeof b.broadcastRow !== 'function') return;
        if(b.subscribers && b.subscribers.size === 0) return;   // nothing to gap
        let failure = null;
        try {
            let rows = await this.db.getAnchorRewardAttestation(rowChain, network, rewardType, roundReference, snapshotBlock, publisher);
            if(rows && rows[0]){
                b.broadcastRow({ table: 'anchor_reward_attestations', row: rows[0] });
                return;
            }
            failure = 'the committed row read back empty';
        } catch(err){
            failure = (err && err.message) ? err.message : String(err);
        }
        logger.error('StateAnchorPublisher: could not stream a committed anchor_reward_attestations row ' +
                      'to mirror subscribers (' + failure + '); forcing subscriber resync');
        try { if(typeof b.dropAllForResync === 'function') b.dropAllForResync('anchor_reward_attestations mirror gap'); }
        catch(_e){ /* the repair itself must never fail a committed attestation row */ }
    },

    // Federate a CONFIRMED reward attestation to every peer (AML #4170).
    //
    // Broadcast, not gossip-forward: only the publisher that watched its own anchor confirm
    // sends, and a receiver never re-broadcasts, so one attested reward costs exactly one
    // fan-out and a Byzantine peer cannot amplify. The payload carries the reward tuple, the
    // XANCPUB signature set, the proven DOGE txid, and the CHECKPOINT IDENTITY
    // (chain/network/block_index/checkpoint_seq/anchor_version) the receiver needs to re-run
    // the same on-chain proof against its own state_checkpoints row and its own DOGE indexer.
    // The reward AMOUNT is deliberately absent: it is a frozen consensus constant both sides
    // read from the twin module, so there is nothing on the wire to lie about.
    federateRewardAttestation(e, sigs, txid){
        if(!this.peerManager || !this.identity || !txid) return;
        let payload = {
            chain: String(e.chain), network: String(e.network),
            reward_type: String(e.rewardType), round_reference: Number(e.roundReference),
            snapshot_block: Number(e.snapshotBlock), publisher: String(e.publisher).toLowerCase(),
            doge_anchor_txid: txid, anchor_version: Number(e.anchorVersion),
            block_index: Number(e.blockIndex), checkpoint_seq: Number(e.checkpointSeq),
            attest_sigs: sigs
        };
        payload.sig_pubkey = this.identity.getPubkeyHex().toLowerCase();
        payload.sig        = this.identity.sign(this.rewardFederationCanonical(payload));
        this.peerManager.broadcast(XANCREWARD, payload);
    },

    // The canonical the SENDER signs over an XANCREWARD payload. Distinct from the XANCPUB
    // reward canonical on purpose: this one authenticates the TRANSPORT (who relayed which
    // tuple, bound to which mined txid and which checkpoint identity), while the XANCPUB
    // quorum inside the payload authenticates the REWARD. A receiver checks both, and the
    // 'XANCREWARD|' tag keeps this signature from ever being replayable as either an
    // attestation co-signature or a checkpoint signature.
    rewardFederationCanonical(d){
        return ['XANCREWARD', String(d.chain), String(d.network), String(d.reward_type),
                String(d.round_reference), String(d.snapshot_block),
                String(d.publisher).toLowerCase(), String(d.doge_anchor_txid).toLowerCase(),
                String(d.anchor_version), String(d.block_index), String(d.checkpoint_seq)].join('|');
    },

    // The federated reward tuple this envelope carries, or null when any field is
    // missing, malformed or outside what a reward wire may name.
    federatedRewardTuple(d){
        let network       = String(d.network || '');
        let snapshotBlock = Number(d.snapshot_block);
        if(!Number.isFinite(snapshotBlock)) return null;
        if(!ar.isAnchorRewardDeriveActive(snapshotBlock, network)) return null;   // gate INERT: no rows exist at all

        let rewardType = String(d.reward_type || '');
        let chain      = String(d.chain || '');
        let publisher  = String(d.publisher || '').toLowerCase();
        let txid       = String(d.doge_anchor_txid || '').toLowerCase();
        let sender     = String(d.sig_pubkey || '').toLowerCase();
        let roundRef   = Number(d.round_reference);
        let version    = Number(d.anchor_version);
        let blockIndex = Number(d.block_index);
        let cpSeq      = Number(d.checkpoint_seq);
        if(!chain || !publisher || !sender) return null;
        if(!/^[0-9a-f]{64}$/.test(txid)) return null;
        if(!Number.isFinite(roundRef) || !Number.isFinite(blockIndex) || !Number.isFinite(cpSeq)) return null;
        if(![0, 1].includes(version)) return null;                                // only the attestation-bearing ANCHOR versions carry a reward
        if(rewardType !== 'anchor_archive' && rewardType !== 'anchor_bundle') return null;
        // BIND the two: v1 is the archive leg, v0 the checkpoint-bundle leg, which is the
        // pairing the BTC derive path enforces (indexer anchor_proof_client._judge:
        // "a v0 can never prove an archive reward and vice versa"). Checked
        // independently, a mis-paired tuple still passes everything downstream: the
        // XANCPUB canonical is rebuilt from the reward_type, so a publisher that really
        // collected a bundle quorum can federate it against the v1 archive head that
        // wraps the same checkpoint, and the drain's byte-match (four core hashes,
        // identical on both legs) confirms it. The row it writes is append-only and
        // never retracted, and the derive path rejects it forever: consensus-table
        // pollution and a permanently stranded credit. Reject at ingress instead.
        if((rewardType === 'anchor_archive') !== (version === 1)) return null;
        if(!Array.isArray(d.attest_sigs) || d.attest_sigs.length === 0) return null;
        if(this.identity && sender === this.identity.getPubkeyHex().toLowerCase()) return null;   // our own broadcast echoing back
            return { network, snapshotBlock, rewardType, chain, publisher, txid, sender, roundRef, version, blockIndex, cpSeq };
    },

    async federatedRewardSigningSet(d, network, snapshotBlock, sender, publisher){
        // The signing/quorum set at the reward's snapshot_block, resolved LOCALLY. This is the
        // same set + weighting the indexer re-verifies against, so a quorum this hub accepts is
        // one the derive path will accept too.
        let signingSet = await this._resolveCapabilitySet('oracle_publish', snapshotBlock, resolveQuorumNetwork({ network: network }, this.network));
        let pubkeys    = new Set((signingSet || []).map(v => String(v.pubkey).toLowerCase()));
        if(pubkeys.size === 0) return null;                                       // unresolved set: fail closed, exactly like every other path here
        if(!pubkeys.has(sender))    return null;                                  // relayer is not one of ours
        if(!pubkeys.has(publisher)) return null;                                  // the earner must itself hold oracle_publish, or the indexer drops it anyway
        if(!ValidatorIdentity.verify(this.rewardFederationCanonical(d), String(d.sig || ''), sender)) return null;
            return { signingSet, pubkeys };
    },

    federatedAttestSigners(d, network, snapshotBlock, rewardType, roundRef, publisher, pubkeys){
        // Rebuild the XANCPUB canonical from the tuple and the FROZEN amount. Nothing from the
        // wire enters it, so an inflated reward_amount cannot be co-signed into existence.
        // A bundle canonical binds only network + snapshot_block (the six positional
        // fields of §2.5); `chain` on this wire is the checkpoint IDENTITY the mined-anchor
        // proof re-runs against, never part of what was signed.
        let canonical = (rewardType === 'anchor_archive')
            ? this._archiveAttestationCanonical({ network: network, snapshot_block: snapshotBlock }, roundRef, publisher)
            : this._attestationCanonical({ network: network, snapshot_block: snapshotBlock }, publisher);

        let seen = new Set(), signers = [], sigs = [];
    for(let s of d.attest_sigs){
            let pk = String(s && s.pubkey || '').toLowerCase();
            if(!pk || seen.has(pk) || !pubkeys.has(pk)) continue;
            if(!ValidatorIdentity.verify(canonical, String(s && s.sig || ''), pk)) continue;
            seen.add(pk);
            signers.push(pk);
            sigs.push({ pubkey: pk, sig: String(s.sig).toLowerCase() });
        }
            return { signers, sigs };
    },

    // Does the re-verified signer list meet the quorum the indexer will hold it to?
    federationQuorumMet(signingSet, pubkeys, signers, network, snapshotBlock){
        let weighted = swq.isStakeWeightedQuorumActive(snapshotBlock, resolveQuorumNetwork({ network: network }, this.network));
        let met;
    if(weighted){
            let weightedSet = (signingSet || []).map(v => ({
                pubkey: String(v.pubkey).toLowerCase(),
                source: String(v.source != null ? v.source : ''),
                weight: String(v.amount != null ? v.amount : '0')
            }));
            // Carry the truncation flag through, exactly as the publisher-attestation round
            // does: meetsStakeThreshold fails CLOSED on an over-cap snapshot, and dropping the
            // flag here would let a receiver accept a quorum on a truncated set that the
            // indexer's own weighted check would then reject, stranding the credit.
            if(signingSet && signingSet.truncated === true) weightedSet.truncated = true;
            met = swq.meetsStakeThreshold(weightedSet, signers);
        } else {
            met = signers.length >= bftQuorumOrSingle(pubkeys.size, 1);
        }
            return met;
    },

    // Receiver half of the federation (AML #4170). Everything here is a re-derivation from
    // this hub's OWN state; the message supplies identity, never authority:
    //   1. the derive flag-day gate, per the row's own snapshot_block, so an inert network
    //      writes nothing at all;
    //   2. the sender's signature over the transport canonical, and the sender's membership
    //      in OUR oracle_publish set at snapshot_block (anti-flood: an outsider cannot make
    //      us run the verification work, let alone queue an entry);
    //   3. the XANCPUB quorum, re-verified against OUR OWN oracle_publish set at
    //      snapshot_block with the canonical rebuilt LOCALLY from the tuple and the FROZEN
    //      amount, so a forged, short, or amount-inflated quorum verifies against nothing;
    //   4. the mined anchor, re-proved by handing the entry to the SAME deferred queue the
    //      publisher uses, so the row is written only once verifyAnchorOnChain binds that
    //      exact txid at that exact ANCHOR version against our own checkpoint row, buried
    //      dogeConfirmations deep on our own DOGE indexer.
    // A receiver never re-broadcasts and never federates its own write (`federate` unset),
    // so the fan-out stays one hop.
    async handleRewardAttestation(envelope){
        let d = envelope && envelope.data;
        if(!d) return;
        let tuple = this.federatedRewardTuple(d);
        if(!tuple) return;
        let { network, snapshotBlock, rewardType, chain, publisher, txid, sender, roundRef, version, blockIndex, cpSeq } = tuple;

        let set = await this.federatedRewardSigningSet(d, network, snapshotBlock, sender, publisher);
        if(!set) return;
        let { signingSet, pubkeys } = set;
        let { signers, sigs } = this.federatedAttestSigners(d, network, snapshotBlock, rewardType, roundRef, publisher, pubkeys);
        if(!this.federationQuorumMet(signingSet, pubkeys, signers, network, snapshotBlock)){
            logger.warn('StateAnchorPublisher: federated reward attestation ' + rewardType + '/' + roundRef +
                         ' from ' + sender + ' failed local XANCPUB re-verification (' + signers.length +
                         ' of ' + pubkeys.size + ' local oracle_publish signers); dropped');
            return;
        }

        // Quorum-valid, but NOT yet proven mined on our own DOGE view. Hand it to the same
        // confirm-then-write queue the publisher uses rather than writing here.
        this.deferRewardAttestation({
            chain: chain, network: network, blockIndex: blockIndex, checkpointSeq: cpSeq,
            txid: txid, anchorVersion: version,
            rewardType: rewardType, roundReference: roundRef, snapshotBlock: snapshotBlock,
            publisher: publisher, attestSigs: sigs
        });
    }

};
