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
 * XChain Hub - Slash Governance 
 *
 * The governance-mediated penalty execution lever over slash_proposals.
 * SlashDetector only ever RECORDS offenses (status 'pending'); nothing
 * enforced them. Decided 2026-07-16: slash_proposals rows are EVIDENCE
 * for a governance vote, and a passed vote executes the penalty. No
 * consensus wire change, and no per-hub counter trust: the proposal is
 * keyed by a content hash of the proposer's evidence rows (never their
 * per-hub auto-increment ids), voters audit it against their OWN local
 * evidence, and the 2/3 snapshot-locked electorate approval - not any
 * single hub's counters - is what authorizes execution.
 *
 * Parameter grammar (rides the existing Governance engine unchanged):
 *
 *     SLASH_PENALTY:<validator_pubkey 64hex>:<evidence_hash 64hex>
 *
 * proposed_value is the penalty action:
 *   - 'suspend': mark the validator's pending slash_proposals rows
 *     'approved', set validators.status='suspended', and propagate the
 *     shrunken active set to every running consensus engine. This is the
 *     hub-layer penalty tier: exclusion from the transport registry and
 *     every PBFT round. On-chain stake is untouched (that is the
 *     indexer's WI-2 rail for provable equivocation).
 *   - 'dismiss': mark the validator's pending rows 'rejected' (the
 *     federation reviewed the evidence and cleared it).
 *
 * Execution runs on EVERY hub via the same 'proposal:finalized' event
 * the capability/provider governance appliers use: the leader emits it
 * from _tallyProposal and followers emit it from their own local
 * re-tally of the GOV_RESULT evidence (R2-H2), so the penalty applies
 * federation-wide without any new message type.
 *
 ********************************************************************/

const crypto = require('crypto');

const SLASH_PENALTY_PREFIX = 'SLASH_PENALTY:';
const PENALTY_ACTIONS      = ['suspend', 'dismiss'];
const HEX64                = /^[0-9a-f]{64}$/;

// Parse a governance parameter of the form
// SLASH_PENALTY:<pubkey 64hex>:<evidence_hash 64hex>.
// Returns { validatorPubkey, evidenceHash } (lowercased) or null.
function parseSlashPenaltyParam(parameter) {
    if (typeof parameter !== 'string' || !parameter.startsWith(SLASH_PENALTY_PREFIX)) return null;
    let rest  = parameter.slice(SLASH_PENALTY_PREFIX.length).toLowerCase();
    let parts = rest.split(':');
    if (parts.length !== 2) return null;
    if (!HEX64.test(parts[0]) || !HEX64.test(parts[1])) return null;
    return { validatorPubkey: parts[0], evidenceHash: parts[1] };
}

// Content hash over a set of slash_proposals rows. Deliberately excludes the
// per-hub auto-increment id and created_at (both hub-local); the identity of
// an offense is (validator, offense_type, round_number, evidence body). Rows
// are canonically sorted so hubs that detected the same offenses in a
// different order derive the same hash.
function computeEvidenceHash(rows) {
    let keys = (rows || []).map(r => {
        let ev = crypto.createHash('sha256').update(String(r.evidence == null ? '' : r.evidence)).digest('hex');
        return String(r.validator_pubkey).toLowerCase() + '|' +
               String(r.offense_type) + '|' +
               String(r.round_number == null ? '' : r.round_number) + '|' + ev;
    }).sort();
    return crypto.createHash('sha256').update(keys.join('\n')).digest('hex');
}

class SlashGovernance {

    constructor(hub) {
        this.hub = hub;
        this.db  = hub.db;
    }

    // Pending evidence rows for one validator (oldest first, deterministic order).
    async _pendingRows(validatorPubkey) {
        return await this.db.doQuery(
            "SELECT id, validator_pubkey, offense_type, round_number, evidence, created_at " +
            "FROM slash_proposals WHERE validator_pubkey = ? AND status = 'pending' " +
            "ORDER BY id ASC",
            [validatorPubkey]
        );
    }

    // Create a governance proposal to execute `penalty` against the validator's
    // pending slash_proposals evidence. The evidence hash is computed from THIS
    // hub's pending rows and embedded in the parameter name, so the electorate
    // votes on a content-identified evidence set; each voter audits it against
    // its own rows (getProposalsForValidator / the evidence summary in the
    // rationale) before approving. Returns the Governance.propose() result plus
    // the evidence summary.
    async proposeSlashPenalty(validatorPubkey, penalty, rationale) {
        if (!this.hub.governance) throw new Error('Governance not active');
        let pk = String(validatorPubkey || '').toLowerCase();
        if (!HEX64.test(pk)) throw new Error('Invalid validator pubkey (must be 64 hex chars)');
        if (!PENALTY_ACTIONS.includes(penalty))
            throw new Error('penalty must be one of: ' + PENALTY_ACTIONS.join(', '));

        let rows = await this._pendingRows(pk);
        if (rows.length === 0)
            throw new Error('No pending slash_proposals evidence for validator ' + pk);

        let evidenceHash = computeEvidenceHash(rows);
        let parameter    = SLASH_PENALTY_PREFIX + pk + ':' + evidenceHash;

        // Human-auditable evidence summary rides in the rationale (capped by
        // Governance's 2000-char limit) so voters see what they are approving
        // without trusting the proposer's hub ids.
        let offenses = {};
        for (let r of rows) offenses[r.offense_type] = (offenses[r.offense_type] || 0) + 1;
        let summary = 'Evidence: ' + rows.length + ' pending offense row(s) [' +
            Object.entries(offenses).map(([t, n]) => t + ' x' + n).join(', ') +
            '], evidence_hash ' + evidenceHash +
            (rationale ? '. ' + String(rationale) : '');
        if (summary.length > 2000) summary = summary.slice(0, 2000);

        let result = await this.hub.governance.propose(parameter, 'pending', penalty, summary);
        return Object.assign({}, result, {
            validator_pubkey: pk,
            penalty: penalty,
            evidence_hash: evidenceHash,
            evidence_rows: rows.length
        });
    }

    // Execution lever: consume a finalized (passed) governance proposal and
    // apply the penalty. Wired to Governance's 'proposal:finalized' event,
    // which only fires for PASSED proposals, on the tally leader and (via the
    // R2-H2 local re-tally) on every follower - so all hubs execute the same
    // outcome without a new wire message. Non-SLASH_PENALTY parameters are
    // ignored (owned by other subsystems). Returns a summary or null.
    async applyFinalized(ev) {
        if (!ev || !ev.parameter) return null;
        let parsed = parseSlashPenaltyParam(ev.parameter);
        if (!parsed) return null;

        let penalty = String(ev.newValue || '').toLowerCase();
        if (!PENALTY_ACTIONS.includes(penalty)) {
            console.warn('SlashGovernance: finalized ' + ev.proposalId + ' carries unknown penalty "' +
                ev.newValue + '"; not executing');
            return null;
        }

        let pk = parsed.validatorPubkey;

        // Audit note: if this hub's local pending evidence no longer hashes to
        // the voted evidence_hash (rows detected before/after the proposal, or
        // per-hub detection skew), the penalty STILL executes - the authority
        // is the 2/3 electorate approval, not local row equality - but the
        // mismatch is logged so operators can reconcile evidence drift.
        try {
            let rows = await this._pendingRows(pk);
            let localHash = computeEvidenceHash(rows);
            if (localHash !== parsed.evidenceHash) {
                console.warn('SlashGovernance: local evidence hash ' + localHash + ' differs from voted ' +
                    parsed.evidenceHash + ' for validator ' + pk.substring(0, 16) +
                    '... (executing the voted penalty; evidence sets drifted across hubs)');
            }
        } catch (e) { /* audit-only; execution proceeds */ }

        let newStatus = penalty === 'suspend' ? 'approved' : 'rejected';
        let res = await this.db.doQuery(
            "UPDATE slash_proposals SET status = ? WHERE validator_pubkey = ? AND status = 'pending'",
            [newStatus, pk]
        );
        let marked = (res && res.affectedRows != null) ? res.affectedRows : 0;

        let suspended = false;
        if (penalty === 'suspend') {
            let vres = await this.db.doQuery(
                "UPDATE validators SET status = 'suspended', updated_at = NOW() " +
                "WHERE signing_pubkey = ? AND status = 'active'",
                [pk]
            );
            suspended = !!(vres && vres.affectedRows > 0);

            // Push the shrunken active set into the transport registry and every
            // running PBFT engine, mirroring deregisterValidator. Without this
            // the suspended validator stays in every in-memory validatorSet
            // until restart and the penalty is a DB row, not an exclusion.
            if (typeof this.hub._loadValidatorPubkeys === 'function') await this.hub._loadValidatorPubkeys();
            if (typeof this.hub._propagateValidatorSet === 'function') await this.hub._propagateValidatorSet();
        }

        console.log('SlashGovernance: executed penalty "' + penalty + '" on validator ' +
            pk.substring(0, 16) + '...: ' + marked + ' evidence row(s) -> ' + newStatus +
            (penalty === 'suspend' ? (suspended ? '; validator suspended' : '; validator was not active') : ''));

        return { validatorPubkey: pk, penalty, evidenceRowsUpdated: marked, suspended };
    }
}

module.exports = SlashGovernance;
module.exports.parseSlashPenaltyParam = parseSlashPenaltyParam;
module.exports.computeEvidenceHash    = computeEvidenceHash;
module.exports.SLASH_PENALTY_PREFIX   = SLASH_PENALTY_PREFIX;
module.exports.PENALTY_ACTIONS        = PENALTY_ACTIONS;
