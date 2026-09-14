/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
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
 * XChain Hub - Oracle Consensus: inbound messages
 *
 * The gossip entry point: the early-arrival buffer a PREPARE or COMMIT waits in until
 * its round exists here, who may be counted toward a quorum, and the PREPARE and COMMIT
 * handlers themselves.
 *
 ********************************************************************/

'use strict';

const { isAdmissibleSigner, provenPubkey } = require('../../lib/chain_signer_admission.js');
const { noteDrop } = require('../../consensus/diagnostics');
const { ORACLE_PROPOSE, ORACLE_PREPARE, ORACLE_COMMIT } = require('./constants.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // --- Early-message buffering (finding F7) ---

    pruneEarlyMessages(now) {
        for (let [round, expiresAt] of this.earlyMessageTtl) {
            if (expiresAt <= now) {
                // A healthy round drains its buffer, so anything still parked
                // here at expiry is a round that never assembled: the vote is
                // gone and this is the only place that says so.
                let lost = this.earlyMessages.get(round);
                noteDrop({ reason: 'early_ttl', phase: 'buffer', round, count: lost ? lost.length : 0 });
                this.earlyMessages.delete(round);
                this.earlyMessageTtl.delete(round);
            }
        }
    },

    // Hold a PREPARE/COMMIT that arrived before this hub's pendingRounds entry
    // exists for the round. Replayed by drainEarlyMessages once it does.
    bufferEarlyMessage(round, envelope) {
        let now = Date.now();
        this.pruneEarlyMessages(now);
        let arr = this.earlyMessages.get(round);
        if (!arr) {
            // Bound the number of distinct buffered rounds (attacker picks `round`).
            // Map iteration is insertion-ordered, so evict the OLDEST round key first.
            while (this.earlyMessages.size >= this.earlyMessageMaxRounds) {
                let oldest = this.earlyMessages.keys().next().value;
                let lost = this.earlyMessages.get(oldest);
                noteDrop({ reason: 'early_capacity', phase: 'buffer', round: oldest, count: lost ? lost.length : 0, evicted_for: round });
                this.earlyMessages.delete(oldest);
                this.earlyMessageTtl.delete(oldest);
            }
            arr = [];
            this.earlyMessages.set(round, arr);
        }
        if (arr.length >= this.earlyMessageMaxPerRound) {
            noteDrop({ reason: 'early_capacity', phase: 'buffer', round, sender: envelope && envelope.sender, envelope });
            return;
        }
        arr.push(envelope);
        this.earlyMessageTtl.set(round, now + this.earlyMessageTtlMs);
    },

    // Replay buffered envelopes through the normal dispatch path. Called from
    // both pendingRounds.set sites (proposer + follower). Deletes the queue
    // up-front so replayed messages can't re-buffer.
    drainEarlyMessages(round) {
        let arr = this.earlyMessages.get(round);
        if (!arr) return;
        this.earlyMessages.delete(round);
        this.earlyMessageTtl.delete(round);
        for (let env of arr) {
            try { this._handleMessage(env); }
            catch (e) { logger.error(nodeUtil.format('Oracle: error replaying buffered message for round %s:', round, e.message)); }
        }
    },

    // Whether an authenticated envelope may be counted toward this round's quorum.
    // Admits on the PROVEN signing key (chain-effective set OR registry), never on
    // envelope.sender: the chain attributes keys, not P2P addresses, so keying on
    // the address is what stranded a staked community validator in the denominator
    // without ever reaching the numerator. Full argument in lib/chain_signer_admission.js.
    _isKnownSender(envelope) {
        return isAdmissibleSigner(this.peerManager, envelope);
    },

    // Verified signing pubkey (lowercase hex) for a sender addr, or null. The
    // registry binding is enforced by PeerManager on every verified envelope
    // (a registered sender's envelope MUST be signed by its registered key), so
    // this resolves to the identity that actually signed, not a claim. Own addr
    // falls back to the local identity for hubs not present in their own registry.
    //
    // Addr-keyed by necessity: its remaining callers walk the submission map,
    // which is keyed by sender. The VOTE path no longer needs it, because
    // prepare/commit sets now hold proven keys directly.
    resolveSenderPubkey(sender) {
        let registry = this.peerManager && this.peerManager.validatorPubkeys;
        let pk = (registry && typeof registry.get === 'function') ? registry.get(sender) : null;
        if (!pk && sender === this.peerManager.validatorAddr) {
            let identity = this.hub && this.hub.getIdentity ? this.hub.getIdentity() : null;
            if (identity) pk = identity.getPubkeyHex();
        }
        return pk ? String(pk).toLowerCase() : null;
    },

    // This hub's own signing key, for seeding its own vote into a key-keyed
    // prepare/commit set. Null only on a hub with no identity and no registry
    // row, which cannot sign a vote anyway; callers skip seeding rather than
    // admit a null into the tally.
    selfPubkey() {
        return this.resolveSenderPubkey(this.peerManager && this.peerManager.validatorAddr);
    },

    // Record one peer's vote in a key-keyed prepare/commit set. The envelope has
    // already cleared _isKnownSender, so it carries a proven key; this is where
    // the forgery bound actually bites, because N envelopes from ONE key collapse
    // to a single Set entry no matter how many distinct senders they name.
    addVote(voteSet, envelope) {
        let pk = provenPubkey(envelope);
        if (pk) voteSet.add(pk);
    },

    _handleMessage(envelope) {
        switch (envelope.type) {
            case ORACLE_PROPOSE:
                // _handlePropose is async because it locks the validator-set
                // snapshot at the round's block boundary via an indexer call.
                // Errors are caught and logged; they never bubble up to the gossip layer.
                this._handlePropose(envelope).catch(err =>
                    logger.error(nodeUtil.format('Oracle: PROPOSE handler error for round %s:',
                        (envelope && envelope.data && envelope.data.round),
                        err && err.message ? err.message : err)));
                break;
            case ORACLE_PREPARE: this.handlePrepare(envelope); break;
            case ORACLE_COMMIT:  this._handleCommit(envelope);  break;
        }
    },

    handlePrepare(envelope) {
        let { round, digest, sig_pubkey, sig } = envelope.data;
        if (!Number.isInteger(round) || round < 0 || !digest) return;   // round 0 is valid (see _handlePropose)

        // Only count PREPARE votes whose signing key the chain or the registry attributes.
        if (!this._isKnownSender(envelope)) {
            noteDrop({ reason: 'unknown_sender', phase: 'prepare', sender: envelope.sender, envelope });
            return;
        }

        let pending = this.pendingRounds.get(round);
        if (!pending) {
            // No pending entry yet: the PROPOSE may still be in flight or its
            // handler mid-await on the snapshot fetch. Buffer instead of
            // dropping (finding F7); replayed once pendingRounds is populated.
            if (!this.finalized.has(round)) this.bufferEarlyMessage(round, envelope);
            else noteDrop({ reason: 'round_torn_down', phase: 'prepare', round, sender: envelope.sender, envelope });
            return;
        }
        if (pending.digest !== digest) {
            noteDrop({ reason: 'digest_mismatch', phase: 'prepare', round, sender: envelope.sender, envelope });
            return;
        }

        this.addVote(pending.prepares, envelope);
        if (sig_pubkey && sig) this.verifyAndStoreSig(pending, sig_pubkey, sig);
        this.checkPrepareQuorum(round);
    },

    _handleCommit(envelope) {
        let { round, digest, sig_pubkey, sig } = envelope.data;
        if (!Number.isInteger(round) || round < 0 || !digest) return;   // round 0 is valid (see _handlePropose)

        // Only count COMMIT votes whose signing key the chain or the registry attributes.
        if (!this._isKnownSender(envelope)) {
            noteDrop({ reason: 'unknown_sender', phase: 'commit', sender: envelope.sender, envelope });
            return;
        }

        let pending = this.pendingRounds.get(round);
        if (!pending) {
            // Same early-arrival race as handlePrepare (finding F7).
            if (!this.finalized.has(round)) this.bufferEarlyMessage(round, envelope);
            else noteDrop({ reason: 'round_torn_down', phase: 'commit', round, sender: envelope.sender, envelope });
            return;
        }
        if (pending.digest !== digest) {
            noteDrop({ reason: 'digest_mismatch', phase: 'commit', round, sender: envelope.sender, envelope });
            return;
        }

        this.addVote(pending.commits, envelope);
        if (sig_pubkey && sig) this.verifyAndStoreSig(pending, sig_pubkey, sig);
        this.checkCommitQuorum(round);
    }
};
