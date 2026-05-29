/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
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

const KNOWN_CAPABILITIES = ['price', 'cross_chain', 'oracle_publish', 'attestation'];
const SELF_TESTS = require('./capabilities/index.js');

class CapabilityRegistry {

    constructor(hub) {
        this.hub        = hub;
        this.db         = hub.db;
        // Per-capability min_stake config. Sourced from p2pConfig.CAPABILITIES at startup;
        // long-term this comes from on-chain governance proposals.
        this.capConfig  = (hub.p2pConfig && hub.p2pConfig.CAPABILITIES) ? hub.p2pConfig.CAPABILITIES : {};
        // Operator opt-out list (capabilities the operator does not want to serve even when qualified + self_test_ok)
        this.disabled   = new Set((hub.p2pConfig && hub.p2pConfig.DISABLED_CAPABILITIES) || []);
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

    // Min stake required to qualify for a capability (as decimal string)
    getMinStake(capability) {
        let entry = this.capConfig[capability];
        if (!entry) return null;
        return entry.MIN_STAKE || '0';
    }

    // Whether the operator has opted out of serving this capability
    isDisabledByOperator(capability) {
        return this.disabled.has(capability);
    }

    /*****************************************************************
     * State mutations (called by qualification sync + self-tests + operator config)
     ****************************************************************/

    // Apply a governance-approved parameter change to the in-memory capability
    // config — the object getMinStake() reads from. capConfig is seeded from
    // p2pConfig.CAPABILITIES at startup and would otherwise stay frozen for the
    // life of the process, so a passed proposal (e.g. raising a capability's
    // MIN_STAKE) would only take effect after a restart. Calling this keeps
    // long-running nodes in sync with freshly-started peers, so the federation
    // computes the same qualified validator set from the same thresholds.
    //
    // The common case is parameterKey === 'MIN_STAKE'. This only mutates config;
    // re-evaluating this node's own qualification against the new threshold is
    // the caller's responsibility, because the on-chain stake amount lives on
    // the hub (see XChainHub.refreshOwnQualification).
    _applyGovernanceChange(capability, parameterKey, newValue) {
        if (KNOWN_CAPABILITIES.indexOf(capability) === -1)
            throw new Error('unknown capability: ' + capability);
        if (!this.capConfig[capability]) this.capConfig[capability] = {};
        this.capConfig[capability][parameterKey] = newValue;
        return this.capConfig[capability][parameterKey];
    }

    // Upsert qualified flag for (pubkey, capability)
    async setQualification(pubkey, capability, qualified, blockIndex) {
        if (KNOWN_CAPABILITIES.indexOf(capability) === -1)
            throw new Error('unknown capability: ' + capability);
        let conn = await this.db.getConnection();
        try {
            // Upsert via ON DUPLICATE KEY UPDATE
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

    // Record the result of a self-test probe
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

    // Toggle operator opt-out for (pubkey, capability)
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

    // List of pubkeys with capability fully active
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

    // Get full state for a specific (pubkey, capability)
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
