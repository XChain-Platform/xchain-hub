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
 * State checkpoint engine - the follower's co-sign
 *
 * Signing a proposed checkpoint only after our own indexer confirms it, and the
 * guards that refuse a record from another network or a malformed wire checkpoint.
 *
 ********************************************************************/

'use strict';

const canonicalForms    = require('./canonical_forms.js');
const ValidatorIdentity = require('../../validators/identity.js');
const { XCHK_SIGN, ALLOWED_CHAINS } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Follower: independently confirm the proposed checkpoint against OUR OWN
    // indexer before signing (never sign state we don't hold ourselves).
    async handleSignReq(envelope){
        let d  = envelope.data;
        let cp = this.normalizeCheckpoint(d.checkpoint);
        if(!cp || !this.identity) return;
        let myPubkey = this.identity.getPubkeyHex().toLowerCase();
        let sender   = String(d.sig_pubkey || '').toLowerCase();
        if(sender === myPubkey) return;                            // our own broadcast

        // Third of the guard's three call sites (propose, co-sign, persist). The
        // indexer byte-match further down rebuilds `mine` with the network OUR OWN
        // indexer reports, so it catches record-vs-indexer drift and is blind to the
        // record-vs-DEPLOYMENT drift this predicate exists for: resolveCapabilityValidators
        // resolves the stake-weighted-quorum gate on `this.network`, so a hub whose
        // HUB_NETWORK disagrees with the record would co-sign under one quorum plane and
        // then refuse the finalized checkpoint under the other. Placed before the tip
        // resolve and the validator resolve, like the persist path, so a cross-network
        // record costs no lookups. A throw is caught by the XCHK_SIGN_REQ .catch in
        // handleMessage; an unscoped hub (this.network === '') is warned, not refused.
        this.assertCheckpointNetwork(cp, 'co-sign');

        // Freshness guard (fail-closed): the leader-supplied snapshot_block selects
        // the validator set AND every flag-day gate below, but is a wire field the
        // proposer chose. Bound it against our OWN resolved BTC tip before it can
        // reach leader-selection (grinding), the validator-set resolve, or the flag-
        // day gates (regression). If we cannot resolve our own tip, we decline rather
        // than co-sign blind. Mirrors StateAnchorPublisher.js:1467 / CrossChainCallEngine.js:536.
        let myBtc = await this.resolveSnapshotBlock();
        if(!Number.isFinite(myBtc)) return;                        // no own tip -> fail closed
        if(Math.abs(myBtc - Number(cp.snapshot_block)) > this.cosignToleranceBlocks) return;

        // Deterministic-seq guard: checkpoint_seq is a pure function of
        // snapshot_block, so re-derive it and refuse a leader whose seq does not match.
        // This closes seq-grinding (a leader picking an arbitrary seq to dodge the
        // replay guard below or fork the anchor/reward bookkeeping) and makes the
        // tightened (chain, network, checkpoint_seq) unique key a true split-brain fence.
        if(Number(cp.checkpoint_seq) !== canonicalForms.deriveCheckpointSeq(cp.snapshot_block)) return;

        let validators = await this.resolveCapabilityValidators('oracle_publish', cp.snapshot_block);
        if(!this.followsCadenceLeader(validators, sender, myPubkey, cp)) return;

        let canonical = canonicalForms.canonicalCheckpoint(cp);
        if(!ValidatorIdentity.verify(canonical, String(d.sig || ''), sender)) return;

        // Replay guard: never co-sign a seq at-or-below one we've already recorded.
        let maxSeq = await this.getMaxCheckpointSeq(cp.chain, cp.network);
        if(maxSeq != null && cp.checkpoint_seq <= maxSeq) return;

        // Independent confirmation from our own indexer/replica.
        let bh = null;
        try { bh = await this.indexerCall(cp.chain, 'getblockhashes', { block_index: cp.block_index }); }
        catch(e){ return; }                                        // can't confirm -> don't sign
        if(!bh) return;
        this.coSignAgainstOwnBlock(cp, canonical, bh, myPubkey);
    },

    // The follower's leader check over the resolved set: this hub must be a member, and
    // the sender must hold the cadence slot for the checkpoint's snapshot_block.
    followsCadenceLeader(validators, sender, myPubkey, cp){
        // Dedupe to DISTINCT pubkeys before ranking, in lockstep with the leader
        // site in leadsCadenceSlot (see the rationale there). Both MUST rank the same list or leader
        // and follower disagree on the cadence slot (split-brain). Inert below SWQ.
        let pubkeys    = [...new Set(validators.map(v => String(v.pubkey).toLowerCase()))].sort();
        if(!pubkeys.includes(myPubkey)) return false;              // we don't qualify
        if(sender !== pubkeys[cp.snapshot_block % pubkeys.length]) return false;   // not the cadence leader
        return true;
    },

    // Co-sign `canonical` only when our own indexer's block `bh` rebuilds the identical
    // canonical, the checkpoint carries the roots its flag-day requires, and this hub
    // has not already signed a different payload at the sequence.
    coSignAgainstOwnBlock(cp, canonical, bh, myPubkey){
        let mine = canonicalForms.canonicalCheckpoint({
            chain: cp.chain, network: String(bh.network || ''), block_index: Number(bh.block_index),
            block_hash:    String(bh.block_hash    || '').toLowerCase(),
            ledger_hash:   String(bh.ledger_hash   || '').toLowerCase(),
            actions_hash:  String(bh.actions_hash  || '').toLowerCase(),
            contract_hash: String(bh.contract_hash || '').toLowerCase(),
            checkpoint_seq: cp.checkpoint_seq, snapshot_block: cp.snapshot_block,
            // SPV Phase 2: re-derive the roots from OUR OWN indexer so we co-sign only
            // when our state_root + block_merkle_root match the proposer's (same self-
            // verification guarantee the three flat hashes already get).
            state_root:           bh.state_root           != null ? String(bh.state_root).toLowerCase()        : null,
            state_root_version:   bh.state_root_version   != null ? Number(bh.state_root_version)   : null,
            block_merkle_root:    bh.block_merkle_root    != null ? String(bh.block_merkle_root).toLowerCase() : null,
            block_merkle_version: bh.block_merkle_version != null ? Number(bh.block_merkle_version) : null
        });
        if(mine !== canonical){
            logger.warn('StateCheckpointEngine: ' + cp.chain + '@' + cp.block_index + ' diverges from our indexer, NOT signing');
            return;
        }

        // Matching the proposer is NOT sufficient post-flag-day. Two rootless
        // hubs agree byte-for-byte (the canonical's root suffix is empty when the roots
        // are null), so the check above passes and we would co-sign a checkpoint that
        // carries none of the light-client commitment its own flag-day requires. The
        // propose path already refuses this; refuse it here too.
        if(canonicalForms.isRootless(cp)){
            logger.warn('StateCheckpointEngine: ' + cp.chain + '@' + cp.block_index +
                ' is checkpoint-commitment active but carries no light-client roots, NOT signing');
            return;
        }

        // One payload per sequence. The leader is free to choose block_index at a given
        // snapshot_block, so this is the guard that stops a proposer collecting quorum on
        // two payloads at one sequence; every check above has already passed for BOTH of
        // them. Last thing before the co-signature leaves the hub, so a proposal this hub
        // would have declined anyway never claims the sequence.
        if(!this.claimSeqSignature(cp, canonical)) return;

        this.peerManager.broadcast(XCHK_SIGN, {
            id: this.roundId(cp), sig_pubkey: myPubkey, sig: this.identity.sign(canonical)
        });
    },

    normalizeCheckpoint(raw){
        if(!raw || !raw.chain || !raw.network || raw.block_index == null) return null;
        let chain = String(raw.chain).toUpperCase();
        if(!ALLOWED_CHAINS.includes(chain)) return null;
        return {
            chain:          chain,
            network:        String(raw.network),
            block_index:    Number(raw.block_index),
            block_hash:     String(raw.block_hash    || '').toLowerCase(),
            ledger_hash:    String(raw.ledger_hash   || '').toLowerCase(),
            actions_hash:   String(raw.actions_hash  || '').toLowerCase(),
            contract_hash:  String(raw.contract_hash || '').toLowerCase(),
            checkpoint_seq: Number(raw.checkpoint_seq),
            snapshot_block: Number(raw.snapshot_block),
            // SPV Phase 2: carried so a peer-received checkpoint reconstructs the SAME
            // post-flag-day canonical the proposer signed. null below the flag-day.
            state_root:           raw.state_root           != null ? String(raw.state_root).toLowerCase()        : null,
            state_root_version:   raw.state_root_version   != null ? Number(raw.state_root_version)   : null,
            block_merkle_root:    raw.block_merkle_root    != null ? String(raw.block_merkle_root).toLowerCase() : null,
            block_merkle_version: raw.block_merkle_version != null ? Number(raw.block_merkle_version) : null
        };
    },

    // The SWQ gate here resolves on the DEPLOYMENT network
    // (`this.network`) while StateAnchorPublisher resolves the same gate on the
    // RECORD's network (resolveQuorumNetwork(cp, ...), "gate on the RECORD network to
    // match the indexer"). Two files, one gate, two planes.
    //
    // The v1 call is kept deliberately rather than switched to cp.network. Switching
    // would make a misconfigured hub silently adopt whatever network a PEER asserts in
    // a gossiped checkpoint, which is a worse failure than the one being fixed: the
    // quorum rule would then be chosen by the sender. Instead the drift is made LOUD.
    //
    // A checkpoint whose network disagrees with this hub's deployment network is
    // refused outright. That surfaces the misconfiguration where it is diagnosable (a
    // named error naming both values) rather than at consensus time, where it appears
    // as an unexplained quorum failure or, worse, as two hubs tallying the same
    // signature set under different rules and disagreeing about whether quorum was
    // reached. Callers treat a throw as "do not sign / do not persist".
    // Scoped to a genuine disagreement between two KNOWN networks. An UNSCOPED hub
    // (this.network === '') is a different, already-documented problem: it silently
    // resolves every flag-day gate to "off" (isStakeWeightedQuorumActive returns false
    // on an unknown network) and it is what #2236 found double-crediting the COLLECT
    // rail. It is warned about loudly here but NOT refused, because refusing would take
    // every unscoped deployment offline at once, which is a far larger behavioural
    // change than this finding asks for and is not what it is about.
    assertCheckpointNetwork(cp, context){
        let recordNet = (cp && cp.network != null) ? String(cp.network) : '';
        if(recordNet === '') return;
        if(this.network === ''){
            if(!this._warnedUnscopedNetwork){
                this._warnedUnscopedNetwork = true;
                logger.warn('StateCheckpointEngine: this hub has NO deployment network, so every ' +
                    'flag-day gate (stake-weighted quorum, equivocation-header, checkpoint-commitment) ' +
                    'resolves to OFF while the checkpoints it handles are scoped to "' + recordNet +
                    '". Set HUB_NETWORK. Continuing on the legacy unscoped path.');
            }
            return;
        }
        if(recordNet === this.network) return;
        throw new Error('checkpoint network mismatch in ' + context + ': record says "' + recordNet +
            '" but this hub is deployed on "' + this.network + '". Refusing rather than ' +
            'resolving the stake-weighted-quorum gate on one plane while the anchor ' +
            'publisher resolves it on the other.');
    },

    async getMaxCheckpointSeq(chain, network){
        let r = await this.db.getStateCheckpointsMaxCheckpointSeq(chain, network);
        return (r.length > 0 && r[0].max_seq != null) ? Number(r[0].max_seq) : null;
    }

};
