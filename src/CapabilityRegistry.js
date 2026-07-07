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
 * XChain Hub - Capability Registry
 *
 * Tracks per-validator capability state in the `validator_capabilities`
 * hub-local table. A capability is active for a validator when:
 *
 *   qualified       = true   (on-chain stake amount >= min_stake[capability])
 * AND self_test_ok    = true   (per-capability selfTest() passed)
 * AND enabled         = true   (operator has not opted out via config)
 *
 * Spec: claude/reports/specs/2026-05-24_capability-staking-model.md
 *
 ********************************************************************/

const KNOWN_CAPABILITIES = ['price', 'cross_chain', 'oracle_publish', 'attestation', 'full_node'];
const SELF_TESTS = require('./capabilities/index.js');

// Parse a governance parameter name of the form CAPABILITY_<CAP>_MIN_STAKE into
// { capability } (lowercased), or null if it is not a known-capability MIN_STAKE field.
// Mirrors XChainHub._parseCapabilityParameter; used here for governance-history rebuild.
function parseCapabilityMinStakeParam(parameter) {
    let m = /^CAPABILITY_(.+)_MIN_STAKE$/.exec(String(parameter || ''));
    if (!m) return null;
    let capability = m[1].toLowerCase();
    if (KNOWN_CAPABILITIES.indexOf(capability) === -1) return null;
    return { capability: capability };
}

// Pre-launch pin (#4352): hub governance CAPABILITY_*_MIN_STAKE changes are disabled.
// The indexer's on-chain acceptance re-derives quorum N from the FROZEN configs/<COIN>.js
// MIN_STAKE constant (no caller override), so the instant a hub governance MIN_STAKE change
// activated, the hub's block-anchored snapshot threshold would diverge from the chain's
// frozen one and fork (a raise stalls liveness; a lower diverges safety). Until the indexer
// acceptance path resolves MIN_STAKE per-block from the same source (the option-(a)
// block-height flag-day), the only safe posture is to forbid the hub from ever moving its
// threshold via governance, so getMinStake(cap, block) stays pinned to the genesis value
// seeded from HUB_CAPABILITY_CONFIG (which must equal the indexer constant). Pre-launch,
// thresholds move only via a coordinated fleet upgrade of configs/<COIN>.js +
// HUB_CAPABILITY_CONFIG. Flip to false when the indexer flag-day ships.
const MIN_STAKE_GOVERNANCE_DISABLED = true;

class CapabilityRegistry {

    constructor(hub) {
        this.hub        = hub;
        this.db         = hub.db;
        // Per-capability min_stake config. Sourced from p2pConfig.CAPABILITIES at startup;
        // long-term this comes from on-chain governance proposals.
        this.capConfig  = (hub.p2pConfig && hub.p2pConfig.CAPABILITIES) ? hub.p2pConfig.CAPABILITIES : {};
        // Block-anchored MIN_STAKE history per capability: an array of
        // { activation_block, value } ordered ascending by activation_block. Seeded from
        // capConfig as a genesis entry (activation_block 0, the operator-configured threshold
        // effective from block 0), then APPENDED (never overwritten) when a governance MIN_STAKE
        // change finalizes, each entry carrying the proposer-declared activation_block. Resolving
        // the threshold for a given block (getMinStake(cap, blockIndex)) is then a deterministic
        // function of block height (identical on every hub regardless of when each wall-clock
        // applied the change), which is what makes CapabilitySnapshot's qualifying validator set
        // (and therefore the quorum N it locks) federation-deterministic. See #3703.
        this.minStakeHistory = {};
        this._seedGenesisHistory();
        // Operator opt-out list (capabilities the operator does not want to serve even when qualified + self_test_ok)
        this.disabled   = new Set((hub.p2pConfig && hub.p2pConfig.DISABLED_CAPABILITIES) || []);
    }

    // (Re)seed the genesis (block-0) MIN_STAKE entry for each capability from the current
    // capConfig. Called at construction and on hot-reload of the capability config. Preserves
    // any already-appended future activation entries (only the activation_block-0 entry is reset),
    // so a reload of operator config does not wipe finalized governance history.
    _seedGenesisHistory() {
        for (let cap of KNOWN_CAPABILITIES) {
            let entry = this.capConfig[cap];
            // Preserve the pre-history getMinStake semantics: an entry present but without a
            // MIN_STAKE key resolves to '0'; an absent entry resolves to null (no genesis seeded).
            if (!entry) continue;
            let genesisValue = entry.MIN_STAKE || '0';
            let hist = this.minStakeHistory[cap] || (this.minStakeHistory[cap] = []);
            let g = hist.find(e => e.activation_block === 0);
            if (g) g.value = String(genesisValue);
            else { hist.push({ activation_block: 0, value: String(genesisValue) }); hist.sort((a, b) => a.activation_block - b.activation_block); }
        }
    }

    // Run self-tests for every known capability for this hub's signing pubkey.
    // Persists results via setSelfTestResult AND applies operator opt-out via setEnabled.
    // Returns an array of { capability, ok, reason } for operator-facing logging.
    async runAllSelfTests(pubkey) {
        let config  = this.hub.p2pConfig || {};
        let results = [];
        for (let cap of KNOWN_CAPABILITIES) {
            let mod = SELF_TESTS[cap];
            let r;
            if (!mod || typeof mod.selfTest !== 'function') {
                r = { ok: false, reason: 'capability module missing selfTest()' };
            } else {
                try {
                    r = await mod.selfTest(config);
                } catch (e) {
                    r = { ok: false, reason: 'selfTest threw: ' + (e && e.message ? e.message : String(e)) };
                }
            }
            await this.setSelfTestResult(pubkey, cap, !!r.ok, r.reason || null);
            await this.setEnabled(pubkey, cap, !this.disabled.has(cap));
            results.push({ capability: cap, ok: !!r.ok, reason: r.reason || null });
        }
        return results;
    }

    // List of capabilities the protocol knows about
    getCapabilities() {
        return KNOWN_CAPABILITIES.slice();
    }

    // Min stake required to qualify for a capability (as decimal string), resolved at a block.
    //   getMinStake(cap, blockIndex) -> the threshold effective AT blockIndex = the value of the
    //     history entry with the greatest activation_block <= blockIndex. This is the
    //     CONSENSUS path: every hub resolves the same value for the same block, so the
    //     qualifying validator set (and quorum N) is federation-deterministic (#3703).
    //   getMinStake(cap)           -> the latest configured threshold (no block context). Used by
    //     non-consensus callers (operator status display, self-test/qualification gossip).
    // Returns null when the capability has no configured threshold (preserve fail-closed
    // semantics in refreshOwnQualification; never default to '0').
    getMinStake(capability, blockIndex) {
        let hist = this.minStakeHistory[capability];
        if (!hist || hist.length === 0) return null;
        if (blockIndex === undefined || blockIndex === null) return hist[hist.length - 1].value;
        let resolved = null;
        for (let e of hist) {
            if (e.activation_block <= blockIndex) resolved = e.value;
            else break; // ascending; no later entry can be in effect at blockIndex
        }
        // blockIndex before the genesis entry (activation_block 0) cannot happen for a real
        // block, but fall back to genesis rather than null to stay fail-safe.
        return resolved !== null ? resolved : hist[0].value;
    }

    // Whether the operator has opted out of serving this capability
    isDisabledByOperator(capability) {
        return this.disabled.has(capability);
    }

    /*****************************************************************
     * State mutations (called by qualification sync + self-tests + operator config)
     ****************************************************************/

    // Append a block-anchored governance MIN_STAKE change to the history (idempotent by
    // activation_block; kept sorted ascending). Unlike an in-place scalar overwrite, the
    // change does NOT take effect until the chain reaches activation_block (getMinStake(cap, N)
    // resolves the value effective at N), so two hubs that append at different wall-clock
    // moments still agree on the threshold for every block. The proposer-declared
    // activation_block is the federation-wide deterministic anchor (it rides in the agreed,
    // authenticated governance proposal). Re-evaluating this node's own qualification is the
    // caller's responsibility (XChainHub.refreshOwnQualification).
    applyMinStakeActivation(capability, activationBlock, newValue) {
        if (KNOWN_CAPABILITIES.indexOf(capability) === -1)
            throw new Error('unknown capability: ' + capability);
        let ab = Number(activationBlock);
        if (!Number.isInteger(ab) || ab < 0)
            throw new Error('invalid activation_block: ' + activationBlock);
        let hist = this.minStakeHistory[capability] || (this.minStakeHistory[capability] = []);
        let existing = hist.find(e => e.activation_block === ab);
        if (existing) { existing.value = String(newValue); }
        else { hist.push({ activation_block: ab, value: String(newValue) }); hist.sort((a, b) => a.activation_block - b.activation_block); }
        return hist;
    }

    // Reconstruct block-anchored MIN_STAKE history from finalized governance proposals after a
    // restart so a long-running hub and a freshly-started one resolve identical thresholds for
    // every block. Genesis entries (from p2pConfig) are seeded in the constructor; this layers
    // the passed proposals on top, ordered by activation_block. Idempotent. Best-effort: a fresh
    // hub without the governance_proposals table simply gets the genesis seed.
    async loadGovernanceHistory() {
        let rows;
        try {
            rows = await this.db.doQuery(
                `SELECT parameter, proposed_value, activation_block
                   FROM governance_proposals
                  WHERE status = 'passed' AND activation_block IS NOT NULL
                  ORDER BY activation_block ASC, id ASC`, []);
        } catch (e) {
            // A transient read failure here silently falls back to genesis-only
            // thresholds. Log the error so the operator can see it rather than
            // having the hub start with an incomplete threshold history.
            console.warn('CapabilityRegistry: loadGovernanceHistory DB read failed, using genesis-only thresholds: ' + (e && e.message));
            return;
        }
        for (let r of rows) {
            let parsed = parseCapabilityMinStakeParam(r.parameter);
            if (!parsed) continue;
            // Pre-launch pin: MIN_STAKE governance is disabled because the indexer
            // acceptance path uses a frozen constant (configs/<COIN>.js MIN_STAKE)
            // with no per-block override. Applying a passed row here would move the
            // hub threshold while the indexer stays frozen, forking quorum N. Skip
            // and warn so any stale row in the DB is visible. When the indexer
            // flag-day ships and this pin flips to false, the replay resumes.
            if (MIN_STAKE_GOVERNANCE_DISABLED) {
                console.warn('CapabilityRegistry: loadGovernanceHistory skipping passed MIN_STAKE row for ' +
                             parsed.capability + ' (activation_block ' + r.activation_block +
                             ') because MIN_STAKE_GOVERNANCE_DISABLED is set');
                continue;
            }
            this.applyMinStakeActivation(parsed.capability, r.activation_block, r.proposed_value);
        }
    }

    // Back-compat shim (test-only / non-block-anchored callers): set the baseline (block-0)
    // MIN_STAKE for a capability. The real governance path is applyMinStakeActivation with a
    // proposer-declared activation_block, driven from XChainHub._applyCapabilityGovernanceChange.
    _applyGovernanceChange(capability, parameterKey, newValue) {
        if (KNOWN_CAPABILITIES.indexOf(capability) === -1)
            throw new Error('unknown capability: ' + capability);
        if (parameterKey === 'MIN_STAKE') return this.applyMinStakeActivation(capability, 0, newValue);
        return null;
    }

    async setQualification(pubkey, capability, qualified, blockIndex) {
        if (KNOWN_CAPABILITIES.indexOf(capability) === -1)
            throw new Error('unknown capability: ' + capability);
        let conn = await this.db.getConnection();
        try {
            await conn.query(
                `INSERT INTO validator_capabilities
                    (signing_pubkey, capability, qualified, qualified_at_block)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    qualified=VALUES(qualified),
                    qualified_at_block=VALUES(qualified_at_block)`,
                [String(pubkey).toLowerCase(), capability, qualified ? 1 : 0, blockIndex || null]
            );
        } finally {
            await conn.release();
        }
    }

    async setSelfTestResult(pubkey, capability, ok, reason) {
        if (KNOWN_CAPABILITIES.indexOf(capability) === -1)
            throw new Error('unknown capability: ' + capability);
        let conn = await this.db.getConnection();
        try {
            await conn.query(
                `INSERT INTO validator_capabilities
                    (signing_pubkey, capability, self_test_ok, self_test_at, self_test_msg)
                 VALUES (?, ?, ?, NOW(), ?)
                 ON DUPLICATE KEY UPDATE
                    self_test_ok=VALUES(self_test_ok),
                    self_test_at=VALUES(self_test_at),
                    self_test_msg=VALUES(self_test_msg)`,
                [String(pubkey).toLowerCase(), capability, ok ? 1 : 0, reason || null]
            );
        } finally {
            await conn.release();
        }
    }

    async setEnabled(pubkey, capability, enabled) {
        if (KNOWN_CAPABILITIES.indexOf(capability) === -1)
            throw new Error('unknown capability: ' + capability);
        let conn = await this.db.getConnection();
        try {
            await conn.query(
                `INSERT INTO validator_capabilities
                    (signing_pubkey, capability, enabled)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    enabled=VALUES(enabled)`,
                [String(pubkey).toLowerCase(), capability, enabled ? 1 : 0]
            );
        } finally {
            await conn.release();
        }
    }

    /*****************************************************************
     * Queries (used by OraclePublisher, CrossChainEngine, attestation, etc.)
     ****************************************************************/

    // Whether all three activation conditions are met for (pubkey, capability)
    async isActive(pubkey, capability) {
        let conn = await this.db.getConnection();
        try {
            let rows = await conn.query(
                `SELECT qualified, self_test_ok, enabled
                 FROM validator_capabilities
                 WHERE signing_pubkey=? AND capability=?
                 LIMIT 1`,
                [String(pubkey).toLowerCase(), capability]
            );
            if (rows.length === 0) return false;
            let r = rows[0];
            return Boolean(r.qualified && r.self_test_ok && r.enabled);
        } finally {
            await conn.release();
        }
    }

    async getActiveValidators(capability) {
        let conn = await this.db.getConnection();
        try {
            let rows = await conn.query(
                `SELECT signing_pubkey
                 FROM validator_capabilities
                 WHERE capability=? AND qualified=1 AND self_test_ok=1 AND enabled=1`,
                [capability]
            );
            return rows.map(r => r.signing_pubkey);
        } finally {
            await conn.release();
        }
    }

    // Count of validators with capability fully active (used for PBFT quorum sizing)
    async getActiveCount(capability) {
        let conn = await this.db.getConnection();
        try {
            let rows = await conn.query(
                `SELECT COUNT(*) AS cnt
                 FROM validator_capabilities
                 WHERE capability=? AND qualified=1 AND self_test_ok=1 AND enabled=1`,
                [capability]
            );
            return rows.length > 0 ? Number(rows[0].cnt) : 0;
        } finally {
            await conn.release();
        }
    }

    async getState(pubkey, capability) {
        let conn = await this.db.getConnection();
        try {
            let rows = await conn.query(
                `SELECT signing_pubkey, capability, qualified, self_test_ok, enabled,
                        self_test_at, self_test_msg, qualified_at_block
                 FROM validator_capabilities
                 WHERE signing_pubkey=? AND capability=?
                 LIMIT 1`,
                [String(pubkey).toLowerCase(), capability]
            );
            return rows.length > 0 ? rows[0] : null;
        } finally {
            await conn.release();
        }
    }

    // List per-validator capability rows, optionally filtered by pubkey and/or
    // capability. Read-only surface for external consumers (e.g. the explorer's
    // validator-capabilities page); returns the full flag set per row so callers
    // can distinguish "not qualified" from "operator-disabled" from "self-test failing".
    async listState({ signingPubkey, capability, limit } = {}) {
        let query = `SELECT id, signing_pubkey, capability, qualified, self_test_ok,
                            enabled, qualified_at_block, updated_at
                     FROM validator_capabilities`;
        let where = [];
        let args = [];
        if (signingPubkey) {
            where.push("signing_pubkey = ?");
            args.push(String(signingPubkey).toLowerCase());
        }
        if (capability) {
            where.push("capability = ?");
            args.push(capability);
        }
        if (where.length) query += " WHERE " + where.join(" AND ");
        let lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);
        query += " ORDER BY id DESC LIMIT " + lim;
        let conn = await this.db.getConnection();
        try {
            return await conn.query(query, args);
        } finally {
            await conn.release();
        }
    }

    // Get all known per-capability state for this hub's identity (operator-facing status display)
    async getOwnState(pubkey) {
        let conn = await this.db.getConnection();
        try {
            let rows = await conn.query(
                `SELECT capability, qualified, self_test_ok, enabled, self_test_at, self_test_msg
                 FROM validator_capabilities
                 WHERE signing_pubkey=?`,
                [String(pubkey).toLowerCase()]
            );
            return rows;
        } finally {
            await conn.release();
        }
    }
}

module.exports = CapabilityRegistry;
module.exports.KNOWN_CAPABILITIES = KNOWN_CAPABILITIES;
module.exports.parseCapabilityMinStakeParam = parseCapabilityMinStakeParam;
module.exports.MIN_STAKE_GOVERNANCE_DISABLED = MIN_STAKE_GOVERNANCE_DISABLED;
