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
 * XChain Hub - the governance ELECTORATE, as a Governance.prototype mixin.
 *
 * Who is allowed to vote on a proposal and how their votes are counted: the
 * snapshot lock that freezes the electorate at creation (R2-M2), the snapshot
 * build, parse and match, and the pure tally over a resolved electorate.
 *
 * Installed on Governance.prototype by src/validators/governance.js the same way
 * src/db/index.js installs its mixins, so `this` is the Governance engine and every
 * method reads the same state it read as a class method.
 *
 ********************************************************************/

const { GOV_SNAPSHOT_MAX_VALIDATORS, GOV_SNAPSHOT_MAX_BYTES, GOV_SNAPSHOT_ACTIVATION } = require('./rules.js');

module.exports = {

    // True once the governance snapshot-lock is in effect for this hub: the
    // configured network's activation height is set (armed) and this hub's best
    // observed BTC block has reached it. Unset height (mainnet pre-arm) or no
    // observed tip => OFF (safe: attach-but-legacy-tally). BTC-anchored so the
    // hub and every peer flip together, exactly like STAKE_WEIGHTED_QUORUM.
    isSnapshotLockActive() {
        let net       = this.hub && this.hub.network;
        let threshold = GOV_SNAPSHOT_ACTIVATION[net];
        if (threshold === null || threshold === undefined) return false;
        let raw    = this.hub ? this.hub._latestBlockIndex : null;
        let latest = (raw !== null && raw !== undefined) ? Number(raw) : null;
        if (latest === null || !Number.isInteger(latest)) return false;
        return latest >= threshold;
    },

    // Capture the current electorate as a pubkey-sorted array of {pubkey, addr}.
    // Phase 1 is count-based over the locked set (stake-weighting deferred: the
    // validators registry has no stake column and governance has no natural
    // capability scope; see the R2-M2 design doc).
    buildValidatorSnapshot() {
        return this.validatorSet
            .map(v => ({ pubkey: String(v.pubkey).toLowerCase(), addr: v.addr }))
            .sort((a, b) => (a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0));
    },

    // Parse + shape-validate a wire/persisted snapshot. Returns a pubkey-sorted
    // array on success, or null if absent/malformed/oversized/duplicated. A JSON
    // string (DB column, wire field) and an already-parsed array are both accepted.
    parseSnapshot(raw) {
        if (raw === null || raw === undefined) return null;
        let arr;
        if (typeof raw === 'string') {
            if (raw.length > GOV_SNAPSHOT_MAX_BYTES) return null;
            try { arr = JSON.parse(raw); } catch (_) { return null; }
        } else {
            arr = raw;
        }
        if (!Array.isArray(arr) || arr.length === 0 || arr.length > GOV_SNAPSHOT_MAX_VALIDATORS) return null;
        let seen = new Set();
        let out  = [];
        for (let e of arr) {
            if (!e || typeof e.pubkey !== 'string' || e.pubkey === '') return null;
            let pk = e.pubkey.toLowerCase();
            if (seen.has(pk)) return null;   // a duplicate collapses the denominator
            seen.add(pk);
            out.push({ pubkey: pk, addr: e.addr });
        }
        return out.sort((a, b) => (a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0));
    },

    // Exact-set match between a parsed snapshot and this hub's current validator
    // set (by pubkey). Fail-closed: a Byzantine proposer shipping a 1-member
    // (self-only) snapshot, or one that omits a locally-known validator, is
    // rejected. Honest proposals pass because every hub is fed the same
    // `validators` table; a transient registration race just drops the proposal
    // (warn log) and the proposer re-proposes. See the R2-M2 design doc.
    snapshotMatchesLocalSet(snap) {
        let local = new Set(this.validatorSet.map(v => String(v.pubkey).toLowerCase()));
        if (local.size !== snap.length) return false;
        for (let e of snap) if (!local.has(e.pubkey)) return false;
        return true;
    },

    // Pure tally over a resolved electorate. `electorate` is the locked snapshot
    // (pubkey array) for a snapshot-locked proposal, or null for a legacy row
    // (tallied against the live validator set, historical behaviour). Only votes
    // from electorate members count when locked. Returns the full breakdown.
    computeTally(votes, electorate) {
        // Resolve the electorate membership that filters the numerator:
        //  - a snapshot-locked proposal: the locked snapshot;
        //  - a legacy row with a non-empty current set: this hub's CURRENT set
        //    (GOV-TALLY-DENOM-1). The denominator (validatorCount below) is already
        //    the current-set size for legacy rows, so counting a vote from a
        //    validator that has since LEFT the set inflated the numerator against a
        //    denominator that no longer includes them. Filtering both by the same
        //    membership keeps the ratio consistent.
        //  - a legacy row with an EMPTY set (standalone / single-node): no
        //    membership to filter against, so count every recorded vote as before
        //    (preserves single-node self-tally, where the node is not enumerated
        //    in its own validator set).
        let members = electorate
            ? new Set(electorate.map(e => e.pubkey))
            : (this.validatorSet.length > 0
                ? new Set(this.validatorSet.map(v => String(v.pubkey).toLowerCase()))
                : null);
        let counted = members
            ? votes.filter(v => members.has(String(v.voter_pubkey).toLowerCase()))
            : votes;
        let approvals  = counted.filter(v => v.vote === 'approve').length;
        let rejections = counted.filter(v => v.vote === 'reject').length;
        let totalVotes = counted.length;
        let validatorCount = electorate ? electorate.length : Math.max(this.validatorSet.length, 1);
        let quorumMet = totalVotes >= Math.ceil(validatorCount / 2);          // 50% participation
        let approved  = quorumMet && approvals >= Math.ceil(validatorCount * 2 / 3); // 2/3+ approval
        return { approvals, rejections, totalVotes, validatorCount, quorumMet, approved };
    }

};
