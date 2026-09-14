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
 * XChain Hub - Cross-Chain Attestation Membership
 *
 * Who may vote and how much a vote is worth: the proven signing key behind an envelope, the
 * block-locked snapshot population a tally is counted against, the quorum resolved from that
 * same snapshot, the leader it elects, and the finalized ring that dedupes a round.
 *
 ********************************************************************/

const crypto = require('crypto');
const hubConfig = require('../../config');
const { positiveIntConfig } = require('../../lib/config_int.js');
const { bftQuorumOrSingle } = require('../../lib/bft_quorum.js');
const { isAdmissibleSigner, provenPubkey } = require('../../lib/chain_signer_admission.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {
    initRoundState() {
        // Validator set (shared with consensus/oracle)
        this.validatorSet = [];

        // Per-chain-pair validator sets: Map<'BTC-DOGE', [{pubkey, addr}]>
        this.chainPairValidators = new Map();

        // Pending attestations: Map<attestationId, pending>
        this.pendingAttestations = new Map();

        // Finalized attestation IDs, bounded FIFO (R2-CCF4): this set is a
        // steady-state dedup guard that only ever grew, so a long-lived hub
        // leaked one entry per finalized attestation forever. Cap it with an
        // insertion-order ring, mirroring CrossChainDexConsensus.markFinalized.
        // The window only needs to outlast in-flight rounds for the same id, so
        // a large bound is ample; re-finalization after eviction is harmless
        // (the DB row keyed on attestationId is idempotent via ON DUPLICATE KEY).
        this.finalized = new Set();
        this._finalizedOrder = [];
        this.finalizedMax = positiveIntConfig(hubConfig.XCHAIN_ATTEST_FINALIZED_MAX, 10000, 'XCHAIN_ATTEST_FINALIZED_MAX');

        // Message handler
        this._messageHandler = null;

        // Sequence counter for attestation ordering
        this.seq = 0;
    },

    // --- Message handlers ---

    // Whether an authenticated envelope may be counted toward attestation quorum.
    // Admits on the PROVEN signing key (chain-effective set OR registry), never on
    // envelope.sender, so a validator that staked on chain is counted without any
    // operator hand-registering it first. Shared definition and the full security
    // argument in lib/chain_signer_admission.js.
    _isKnownSender(envelope) {
        return isAdmissibleSigner(this.peerManager, envelope);
    },

    // Verified signing pubkey (lowercase hex) for a sender addr, or null. PeerManager
    // enforces the registry binding on every verified envelope (a registered sender's
    // envelope MUST carry its registered key's signature), so this resolves the identity
    // that actually signed rather than a claim. Own addr falls back to the local identity
    // for a hub absent from its own registry. Mirrors OracleConsensus.resolveSenderPubkey.
    resolveSenderPubkey(sender) {
        let registry = this.peerManager && this.peerManager.validatorPubkeys;
        let pk = (registry && typeof registry.get === 'function') ? registry.get(sender) : null;
        if (!pk && this.peerManager && sender === this.peerManager.validatorAddr) {
            let identity = this.hub && this.hub.getIdentity ? this.hub.getIdentity() : null;
            if (identity) pk = identity.getPubkeyHex();
        }
        return pk ? String(pk).toLowerCase() : null;
    },

    // This hub's own signing key, for seeding its own vote into a key-keyed
    // prepare/commit set. Null only on a hub that cannot sign a vote anyway.
    selfPubkey() {
        return this.resolveSenderPubkey(this.peerManager && this.peerManager.validatorAddr);
    },

    // Record one peer's vote in a key-keyed set. The envelope has already cleared
    // _isKnownSender, so it carries a proven key. N envelopes from ONE key collapse
    // to a single entry however many distinct senders they name, which is what
    // bounds count-mode forgery here.
    addVote(voteSet, envelope) {
        let pk = provenPubkey(envelope);
        if (pk) voteSet.add(pk);
    },

    // Pubkey set of the round's locked cross_chain snapshot, or null when no usable
    // snapshot resolved. Null DISABLES the membership filter, which preserves the
    // bootstrap / single-node path _resolveQuorum already keeps (there the quorum came
    // from the live validator set, not from a snapshot, so there is no snapshot
    // population to gate against). Mirrors OracleConsensus.memberPubkeySet.
    memberPubkeySet(snapshot) {
        if (!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0) return null;
        let set = new Set();
        for (let v of snapshot.validators) {
            if (v && v.pubkey) set.add(String(v.pubkey).toLowerCase());
        }
        return set.size > 0 ? set : null;
    },

    // Resolve the member-pubkey set for a round at the same block boundary _resolveQuorum
    // sized N from. Read separately (rather than by widening _resolveQuorum's return) so
    // the quorum contract callers and tests depend on is untouched; CapabilitySnapshot
    // caches per (capability, block), so this is a cache hit behind the quorum resolve.
    // Never throws: a failure here degrades to the legacy unfiltered tally, exactly as an
    // unresolved snapshot already does, and _resolveQuorum has already refused the round
    // outright in the federated case.
    async resolveMemberPubkeys(btcBlockHeight) {
        if (!this.hub.capabilitySnapshot || btcBlockHeight == null) return null;
        try {
            return this.memberPubkeySet(
                await this.hub.capabilitySnapshot.getSnapshot('cross_chain', btcBlockHeight));
        } catch (err) {
            logger.warn('CrossChain: could not resolve the cross_chain member set at block ' +
                btcBlockHeight + ' (' + (err && err.message) + '); tallying unfiltered');
            return null;
        }
    },

    // --- Utilities ---

    // Get the validator set for a specific chain pair, or fall back to the full set
    getChainPairSet(sourceChain, destChain) {
        if (this.chainPairValidators.size > 0) {
            // Try both orderings of the chain pair
            let key1 = sourceChain + '-' + destChain;
            let key2 = destChain + '-' + sourceChain;
            let set = this.chainPairValidators.get(key1) || this.chainPairValidators.get(key2);
            if (set && set.length > 0) return set;
        }
        // Fall back to full validator set
        return this.validatorSet;
    },

    _getLeader(seq, sourceChain, destChain) {
        let set = (sourceChain && destChain)
            ? this.getChainPairSet(sourceChain, destChain)
            : this.validatorSet;
        if (set.length === 0) return null;
        return set[seq % set.length];
    },

    // Resolve the round's quorum from a deterministic block-boundary snapshot
    // of the cross_chain capability set (every hub queries the same blockIndex
    // on the BTC indexer and arrives at the same N, so two hubs processing the
    // same attestation at different wall-clock times lock the same quorum).
    // Federation-split guard (fail closed), mirroring Consensus.js:170-173 and
    // OraclePublisher's retired live-registry fallback. The prior
    // form fell back to this hub's LOCAL live validator set (or, worse, open-peer
    // count + 1 in getQuorum) whenever the snapshot was unresolved -- so a hub with
    // an unreachable BTC indexer locked a DIFFERENT N/quorum than a healthy peer for
    // the same (cross_chain, block) round. When federated, refuse rather than
    // split. Single-node / regtest hubs (no snapshot AND a live quorum of 0, i.e. no
    // peers) have no peer to diverge from, so they keep the live fallback for
    // bootstrap. btcBlockHeight is compared `!= null` (not truthiness) so a genuine
    // block height of 0 still resolves a snapshot instead of being treated as absent.
    async _resolveQuorum(sourceChain, destChain, btcBlockHeight) {
        let snapshot = (this.hub.capabilitySnapshot && btcBlockHeight != null)
            ? await this.hub.capabilitySnapshot.getSnapshot('cross_chain', btcBlockHeight)
            : null;
        if (snapshot) return this.hub.capabilitySnapshot.getQuorum(snapshot);
        let live = this.getQuorum(sourceChain, destChain);
        if (live > 0) {
            throw new Error('CrossChain: refusing to resolve quorum without a deterministic ' +
                'cross_chain snapshot while federated (block ' + btcBlockHeight + '); the indexer ' +
                'capability snapshot is unavailable and falling back to the local validator set ' +
                'would fork N/quorum against peers for this round');
        }
        return live;
    },

    getQuorum(sourceChain, destChain) {
        let N;
        if (sourceChain && destChain) {
            let set = this.getChainPairSet(sourceChain, destChain);
            N = set.length;
        } else {
            N = this.validatorSet.length;
        }
        if (N <= 0) {
            let peers = this.peerManager.getPeerStatus().filter(p => p.state === 'open');
            N = peers.length + 1;
        }
        // N<=1: single node, no peer to reach (0 = caller bypasses). Above that,
        // the majority-floored BFT threshold (bft_quorum.js).
        return bftQuorumOrSingle(N, 0);
    },

    _digest(attestationId, confirmations) {
        let payload = JSON.stringify({ attestationId, confirmations });
        return crypto.createHash('sha256').update(payload).digest('hex');
    },
};
