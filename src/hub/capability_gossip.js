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
 * XChain Hub - Capability Gossip
 *
 * Own qualification against the staked floor, the activation state this hub
 * gossips, what it accepts from a peer claiming one, and the exact decimal
 * comparison the threshold is decided by.
 *
 ********************************************************************/

const { getLogger, getRegistry } = require('../observability');
const logger = getLogger();

// Throttle the unverified-acceptance warning per (pubkey, capability, reason); peers
// re-gossip every activation on each recheck tick, so an indexer outage would flood the log.
const UNVERIFIED_LOG_WINDOW_MS = 60000;
const UNVERIFIED_LOG_MAX_KEYS  = 1000;

// Count activations accepted without a stake check; built at first use, once per process.
let _unverifiedCounter = null;
function unverifiedCounter(){
    if(!_unverifiedCounter){
        _unverifiedCounter = getRegistry().counter({
            name: 'xchain_capability_qualification_unverified_total',
            help: 'Capability activations accepted without a stake-snapshot check, by capability and reason',
            labelNames: ['capability', 'reason']
        });
    }
    return _unverifiedCounter;
}

class CapabilityGossip {

    // Entry point for an integration that observed this hub's on-chain stake change.
    // Recomputes qualification and gossips activation, the gossip only when the active
    // state actually moves.
    async refreshOwnQualification(stakeAmount, blockIndex){
        if(!this.identity || !this.capabilityRegistry) return;
        let pubkey = this.identity.getPubkeyHex();
        this._latestBlockIndex = blockIndex || this._latestBlockIndex;
        let amount = String(stakeAmount || '0');
        this._latestStakeAmount = amount;
        for(let cap of this.capabilityRegistry.getCapabilities()){
            // Resolve the threshold AT this block, the value the federation locks against.
            let minStake = this.capabilityRegistry.getMinStake(cap, blockIndex);
            let qualified;
            if(minStake === null || minStake === undefined){
                // Fail CLOSED. Defaulting the threshold to '0' would qualify an unstaked node for
                // everything and diverge from the indexer's authoritative threshold, which is a
                // frozen configs/<COIN>.js consensus constant and not a governance value. The hub's
                // genesis MIN_STAKE, from HUB_CAPABILITY_CONFIG, must EQUAL that constant. A
                // capability with no configured threshold stays inactive until one is supplied.
                qualified = false;
                if(!this._warnedMissingMinStake) this._warnedMissingMinStake = new Set();
                if(!this._warnedMissingMinStake.has(cap)){
                    logger.warn('Capability "' + cap + '": no MIN_STAKE configured ' +
                        '(set CAPABILITIES.' + cap + '.MIN_STAKE in HUB_CAPABILITY_CONFIG); ' +
                        'treating as NOT qualified until a threshold is provided.');
                    this._warnedMissingMinStake.add(cap);
                }
            } else {
                qualified = this.compareDecimal(amount, minStake) >= 0;
            }
            await this.capabilityRegistry.setQualification(pubkey, cap, qualified, blockIndex);
        }
        await this.broadcastOwnCapabilityState(pubkey);
    }

    // Map a finalized governance proposal onto the in-memory capability config and
    // re-evaluate own qualification. Recognizes CAPABILITY_<CAP>_MIN_STAKE parameters;
    // anything else belongs to a different subsystem.
    async applyCapabilityGovernanceChange(ev){
        if(!ev || !ev.parameter || !this.capabilityRegistry) return;
        const { CapabilityRegistry } = this.constructor.modules;
        let parsed = this.parseCapabilityParameter(ev.parameter);
        if(!parsed) return;
        // Block-anchored apply: append the new threshold to the capability's history keyed
        // by the proposer-declared activation_block instead of overwriting a live scalar.
        // The change does not take effect until the chain reaches activation_block, and
        // getMinStake(cap, N) resolves the value effective at N, so hubs that finalize at
        // different wall-clock moments still agree on the threshold for every block. A
        // finalized MIN_STAKE proposal with no activation_block is ignored, not applied.
        if(parsed.parameterKey === 'MIN_STAKE'){
            // Pre-launch pin, and a final safety net rather than the primary guard: even if a
            // MIN_STAKE proposal:finalized somehow fires, say in a mixed-version rollout where
            // an un-pinned hub passed one, do NOT move the threshold. The indexer accepts
            // against a frozen configs/<COIN>.js constant, so any hub-side move forks the
            // federation from the chain, and getMinStake stays pinned to the genesis value.
            // Lift with MIN_STAKE_GOVERNANCE_DISABLED when the indexer flag-day ships.
            if(CapabilityRegistry.MIN_STAKE_GOVERNANCE_DISABLED){
                logger.warn('Governance MIN_STAKE change for ' + parsed.capability +
                    ' ignored: hub governance MIN_STAKE changes are disabled pre-launch (#4352)');
                return;
            }
            if(ev.activationBlock === undefined || ev.activationBlock === null || !Number.isInteger(Number(ev.activationBlock))){
                logger.warn('Governance MIN_STAKE change for ' + parsed.capability +
                    ' has no activation_block; not applying (would be unanchored, risking cross-hub divergence)');
                return;
            }
            this.capabilityRegistry.applyMinStakeActivation(parsed.capability, Number(ev.activationBlock), String(ev.newValue));
        } else {
            this.capabilityRegistry.applyGovernanceChange(parsed.capability, parsed.parameterKey, String(ev.newValue));
        }
        // Drop cached validator-set snapshots for this capability so the next consensus
        // read re-queries the indexer under the new threshold. The cache key already folds
        // in min_stake, so this only reclaims the unreachable entries early rather than
        // waiting out the TTL.
        if(this.capabilitySnapshot && typeof this.capabilitySnapshot.flushCapability === 'function'){
            this.capabilitySnapshot.flushCapability(parsed.capability);
        }
        // Re-evaluate own qualification now against the latest observed stake; the periodic
        // stake poll reconciles with fresh on-chain truth on its next tick, and doing it
        // here too closes the window without waiting for that.
        await this.refreshOwnQualification(this._latestStakeAmount, this._latestBlockIndex);
    }

    // Parse CAPABILITY_<CAP>_MIN_STAKE into { capability, parameterKey }, where <CAP> is
    // the uppercased capability name. Null for anything else.
    parseCapabilityParameter(parameter){
        let m = /^CAPABILITY_(.+)_MIN_STAKE$/.exec(String(parameter || ''));
        if(!m) return null;
        let capability = m[1].toLowerCase();
        if(!this.capabilityRegistry || this.capabilityRegistry.getCapabilities().indexOf(capability) === -1) return null;
        return { capability: capability, parameterKey: 'MIN_STAKE' };
    }

    // In-flight guard: _capabilityRecheckTimer fires on a bare setInterval while
    // runAllSelfTests fans out to every module's slow healthCheck, so passes would stack
    // and emit duplicate CAPABILITY_ACTIVATED/DEACTIVATED broadcasts. The config-watch
    // re-check is skipped while a pass runs; the next scheduled tick applies the reload.
    async runOwnCapabilityCheck(pubkey){
        if(!this.capabilityRegistry) return;
        if(this._capabilityCheckRunning) return;
        this._capabilityCheckRunning = true;
        try {
            await this.capabilityRegistry.runAllSelfTests(pubkey);
            await this.broadcastOwnCapabilityState(pubkey);
        } finally {
            this._capabilityCheckRunning = false;
        }
    }

    async broadcastOwnCapabilityState(pubkey){
        if(!this.peerManager || !this.identity || !this.capabilityRegistry) return;
        for(let cap of this.capabilityRegistry.getCapabilities()){
            let active = await this.capabilityRegistry.isActive(pubkey, cap);
            let data = {
                pubkey:     pubkey,
                capability: cap,
                block_at:   this._latestBlockIndex
            };
            if(!active){
                let state = await this.capabilityRegistry.getState(pubkey, cap);
                if(state && state.self_test_msg) data.reason = state.self_test_msg;
            }
            this.peerManager.broadcast(active ? 'CAPABILITY_ACTIVATED' : 'CAPABILITY_DEACTIVATED', data);
        }
    }

    // PeerManager has already sig-verified the envelope, so the only extra requirement
    // is that data.pubkey match the sender's, or operator A could claim B's capabilities.
    async handleCapabilityMessage(envelope){
        if(!this.capabilityRegistry) return;
        let data = envelope.data || {};
        if(!data.pubkey || !data.capability) return;
        let senderPubkey = this.peerManager && this.peerManager.validatorPubkeys
            ? this.peerManager.validatorPubkeys.get(envelope.sender) : null;
        if(senderPubkey && String(data.pubkey).toLowerCase() !== String(senderPubkey).toLowerCase()){
            logger.warn('Capability message from ' + envelope.sender + ' claims pubkey ' + data.pubkey + ' but sender is registered as ' + senderPubkey + '; dropping');
            return;
        }
        if(envelope.type === 'CAPABILITY_SELF_TEST'){
            await this.capabilityRegistry.setSelfTestResult(data.pubkey, data.capability, !!data.ok, data.reason || null);
        } else if(envelope.type === 'CAPABILITY_ACTIVATED'){
            // The self-test is a local-readiness claim and only matters alongside
            // qualification, so it is accepted as-is. The qualification claim is stake-backed,
            // so verify it against the indexer's authoritative snapshot at the claimed block;
            // a peer must not be able to advertise a capability it is not actually staked for.
            // When the indexer cannot be consulted, meaning no block in the message or an
            // unreachable indexer, accept the claim to preserve liveness; slashing-for-failure
            // stays the backstop. Every such unchecked acceptance is counted and logged.
            await this.capabilityRegistry.setSelfTestResult(data.pubkey, data.capability, true, null);
            let qualified = true;
            let unverified = null;
            let error = null;
            try {
                if(!this.capabilitySnapshot) unverified = 'no_snapshot_service';
                else if(data.block_at === undefined || data.block_at === null) unverified = 'no_block';
                else {
                    let snap = await this.capabilitySnapshot.getSnapshot(data.capability, data.block_at);
                    // getSnapshot answers null, rather than throwing, when the indexer is down or refuses.
                    if(!snap) unverified = 'snapshot_unavailable';
                    else if(!this.capabilitySnapshot.isInSnapshot(snap, data.pubkey)){
                        logger.warn('Capability activation from ' + envelope.sender + ' for "' + data.capability +
                            '" rejected: pubkey ' + data.pubkey + ' is not in the indexer stake snapshot at block ' +
                            data.block_at + ' (claimed qualification it is not staked for).');
                        qualified = false;
                    }
                }
            } catch(e){
                unverified = 'snapshot_error';
                error = e;
            }
            if(unverified) this.noteUnverifiedQualification(envelope, data, unverified, error);
            await this.capabilityRegistry.setQualification(data.pubkey, data.capability, qualified, data.block_at || null);
            await this.capabilityRegistry.setEnabled(data.pubkey, data.capability, true);
        } else if(envelope.type === 'CAPABILITY_DEACTIVATED'){
            // Failing the peer's self-test is what routes work away from it.
            await this.capabilityRegistry.setSelfTestResult(data.pubkey, data.capability, false, data.reason || 'peer reported deactivation');
        }
    }

    // Record a stake-backed claim accepted without a snapshot check. The counter moves on
    // every one; the warning is throttled. A capability outside the known set is labelled
    // 'other', since a peer chooses the string and must not grow the series without bound.
    noteUnverifiedQualification(envelope, data, reason, error){
        let known = this.capabilityRegistry.getCapabilities ? this.capabilityRegistry.getCapabilities() : [];
        let capability = known.indexOf(data.capability) === -1 ? 'other' : data.capability;
        unverifiedCounter().inc({ capability: capability, reason: reason });

        let log = this._unverifiedQualificationLog || (this._unverifiedQualificationLog = new Map());
        let key = String(data.pubkey).toLowerCase() + '|' + capability + '|' + reason;
        let now = Date.now();
        let last = log.get(key);
        if(last !== undefined && now - last < UNVERIFIED_LOG_WINDOW_MS) return;
        // Re-insert so the map stays ordered oldest-first, then drop the oldest past the cap.
        log.delete(key);
        log.set(key, now);
        while(log.size > UNVERIFIED_LOG_MAX_KEYS) log.delete(log.keys().next().value);
        logger.warn('Capability activation from ' + (envelope && envelope.sender) + ' for "' + data.capability +
            '" accepted WITHOUT a stake check (' + reason + (error ? ': ' + (error.message || String(error)) : '') +
            '): pubkey ' + data.pubkey + ', block_at ' + data.block_at);
    }

    // Exact decimal string comparison. Aggregated stake can exceed float64's safe-integer
    // range (DECIMAL(30,8) sums), so parseFloat would round two distinct amounts together
    // and mis-qualify an underweight validator. Returns -1, 0 or 1; 0 if unparseable.
    compareDecimal(a, b){
        let pa = this.parseDecimalParts(a);
        let pb = this.parseDecimalParts(b);
        if(!pa || !pb) return 0;
        if(pa.neg !== pb.neg) return pa.neg ? -1 : 1;
        let scale = Math.max(pa.frac.length, pb.frac.length);
        let ai = BigInt(pa.int + pa.frac.padEnd(scale, '0'));
        let bi = BigInt(pb.int + pb.frac.padEnd(scale, '0'));
        let cmp = ai < bi ? -1 : (ai > bi ? 1 : 0);
        return pa.neg ? -cmp : cmp;
    }

    // Parse a decimal string into { neg, int, frac }, or null when not a finite decimal.
    parseDecimalParts(v){
        let s = String(v == null ? '' : v).trim();
        if(!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
        let neg = s[0] === '-';
        if(s[0] === '+' || s[0] === '-') s = s.slice(1);
        let dot = s.indexOf('.');
        let int  = (dot === -1 ? s : s.slice(0, dot)) || '0';
        let frac = dot === -1 ? '' : s.slice(dot + 1);
        if(/^0*$/.test(int) && /^0*$/.test(frac)) neg = false;
        return { neg: neg, int: int, frac: frac };
    }
}

module.exports = CapabilityGossip;
