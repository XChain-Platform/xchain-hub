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
 * XChain Hub - Governance Engine
 *
 * Off-chain governance via PBFT voting. Validators propose parameter
 * changes, vote over a configurable voting period, and apply changes
 * at the next epoch boundary when 2/3+ approve.
 *
 * Proposal lifecycle: PROPOSE -> VOTING (7 days) -> TALLY -> APPLY/REJECT
 *
 ********************************************************************/

const crypto = require('crypto');
const EventEmitter = require('events');
const ValidatorIdentity = require('./ValidatorIdentity.js');
const { parseCapabilityMinStakeParam, MIN_STAKE_GOVERNANCE_DISABLED } = require('./CapabilityRegistry.js');
const { parseAttestationProviderParam } = require('./ProviderRegistry.js');

const GOV_PROPOSE = 'GOV_PROPOSE';
const GOV_VOTE    = 'GOV_VOTE';
const GOV_RESULT  = 'GOV_RESULT';

// Block-anchored activation for capability MIN_STAKE changes (#3703). Capability snapshots are
// BTC-anchored, so activation heights are reasoned in BTC blocks. A MIN_STAKE change must not
// take effect until every hub has finalized it -- i.e. comfortably after the voting period ends
// plus a propagation/apply margin -- so the activation block is computed as the proposer's latest
// observed block + (voting period in blocks) + a safety buffer. The proposer's value rides in the
// agreed, authenticated proposal, so every hub anchors the change to the identical block.
const BTC_BLOCK_MS                    = 600000; // ~10 min/block
const ACTIVATION_SAFETY_BUFFER_BLOCKS = 50;     // ~8h past finalize for GOV_RESULT propagation

// Change bounds
const MAX_INCREASE         = 0.50;  // 50% max increase
const MAX_DECREASE         = 0.33;  // 33% max decrease
const MAX_SLASH_INCREASE   = 0.25;  // 25% max increase for slashing params
const MAX_SLASH_DECREASE   = 0.20;  // 20% max decrease for slashing params
const COOLDOWN_DAYS        = 14;    // Days before re-proposing a rejected parameter

const SLASHING_PARAMS = ['SLASH_DEVIATION_THRESHOLD', 'SLASH_MISSED_ROUNDS_THRESHOLD'];

// R2-M2: snapshot-lock the electorate onto each proposal. Below the activation
// height a hub still ATTACHES and PERSISTS a validator_snapshot (harmless,
// additive) but tallies by the legacy live-set rule and accepts snapshotless
// proposals; at/above it the snapshot is REQUIRED and is the tally denominator,
// so validator-set churn between propose() and tally can no longer move the
// quorum/approval goalposts. Same shape + BTC-anchored gating discipline as
// STAKE_WEIGHTED_QUORUM_ACTIVATION. mainnet ARMED 2026-07-16 (, with the
//  flag-day set): BTC 969500 ~2026-10-01 (ratified anchor; derived from
// tip 957062 on 07-07 at ~144 blocks/day); deploy every hub before this era.
const GOV_SNAPSHOT_ACTIVATION = { mainnet: 969500, testnet: 0, regtest: 0 };

// Bounds on a persisted/wire snapshot (DoS): a validator set is small, so a
// snapshot far past these is adversarial padding, not a real electorate.
const GOV_SNAPSHOT_MAX_VALIDATORS = 1000;
const GOV_SNAPSHOT_MAX_BYTES      = 262144;   // 256 KB serialized

// Minimum activation block for parameters that are block-anchored. Used on the
// follower path to re-validate the proposer-supplied activation_block so a
// dishonest peer cannot install an already-past (or too-soon) anchor.
// `latestBlock` is this hub's best observed BTC height at receive time.
// `votingPeriodMs` is this hub's local governance.votingPeriod.
// Returns the minimum valid activation_block.
function _minActivationBlock(latestBlock, votingPeriodMs) {
    let votingBlocks = Math.ceil(votingPeriodMs / BTC_BLOCK_MS);
    return latestBlock + votingBlocks + ACTIVATION_SAFETY_BUFFER_BLOCKS;
}

// Parse a decimal string into { neg, int, frac } digit strings, or null if it is
// not a finite decimal. Used for exact (non-float) bounds comparison so large
// parameter values aren't rounded past the float64 safe-integer range.
function parseDecimalParts(v){
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

// Render parsed decimal parts as a signed BigInt scaled to `scale` fraction digits.
function toScaledBigInt(parts, scale){
    let v = BigInt(parts.int + parts.frac.padEnd(scale, '0'));
    return parts.neg ? -v : v;
}

class Governance extends EventEmitter {

    constructor(hub) {
        super();
        this.hub         = hub;
        this.peerManager = hub.getPeerManager();
        this.identity    = hub.getIdentity();
        this.db          = hub.db;

        this.validatorSet = [];
        this._messageHandler = null;
        this._tallyTimer = null;

        this.votingPeriod  = parseInt(process.env.GOV_VOTING_PERIOD)       || (7 * 24 * 60 * 60 * 1000); // 7 days
        this.tallyInterval = parseInt(process.env.GOVERNANCE_TALLY_INTERVAL) || 60000;
    }

    setValidatorSet(validators) {
        this.validatorSet = validators;
    }

    // True once the governance snapshot-lock is in effect for this hub: the
    // configured network's activation height is set (armed) and this hub's best
    // observed BTC block has reached it. Unset height (mainnet pre-arm) or no
    // observed tip => OFF (safe: attach-but-legacy-tally). BTC-anchored so the
    // hub and every peer flip together, exactly like STAKE_WEIGHTED_QUORUM.
    _isSnapshotLockActive() {
        let net       = this.hub && this.hub.network;
        let threshold = GOV_SNAPSHOT_ACTIVATION[net];
        if (threshold === null || threshold === undefined) return false;
        let raw    = this.hub ? this.hub._latestBlockIndex : null;
        let latest = (raw !== null && raw !== undefined) ? Number(raw) : null;
        if (latest === null || !Number.isInteger(latest)) return false;
        return latest >= threshold;
    }

    // Capture the current electorate as a pubkey-sorted array of {pubkey, addr}.
    // Phase 1 is count-based over the locked set (stake-weighting deferred: the
    // validators registry has no stake column and governance has no natural
    // capability scope; see the R2-M2 design doc).
    _buildValidatorSnapshot() {
        return this.validatorSet
            .map(v => ({ pubkey: String(v.pubkey).toLowerCase(), addr: v.addr }))
            .sort((a, b) => (a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0));
    }

    // Parse + shape-validate a wire/persisted snapshot. Returns a pubkey-sorted
    // array on success, or null if absent/malformed/oversized/duplicated. A JSON
    // string (DB column, wire field) and an already-parsed array are both accepted.
    _parseSnapshot(raw) {
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
    }

    // Exact-set match between a parsed snapshot and this hub's current validator
    // set (by pubkey). Fail-closed: a Byzantine proposer shipping a 1-member
    // (self-only) snapshot, or one that omits a locally-known validator, is
    // rejected. Honest proposals pass because every hub is fed the same
    // `validators` table; a transient registration race just drops the proposal
    // (warn log) and the proposer re-proposes. See the R2-M2 design doc.
    _snapshotMatchesLocalSet(snap) {
        let local = new Set(this.validatorSet.map(v => String(v.pubkey).toLowerCase()));
        if (local.size !== snap.length) return false;
        for (let e of snap) if (!local.has(e.pubkey)) return false;
        return true;
    }

    // Pure tally over a resolved electorate. `electorate` is the locked snapshot
    // (pubkey array) for a snapshot-locked proposal, or null for a legacy row
    // (tallied against the live validator set, historical behaviour). Only votes
    // from electorate members count when locked. Returns the full breakdown.
    _computeTally(votes, electorate) {
        let members = electorate ? new Set(electorate.map(e => e.pubkey)) : null;
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

    async start() {
        this._messageHandler = (envelope) => this._handleMessage(envelope);
        this.peerManager.on('message', this._messageHandler);

        this._tallyTimer = setInterval(() => this._checkExpiredProposals(), this.tallyInterval);

        console.log('Governance engine started (voting period: ' + (this.votingPeriod / 86400000).toFixed(1) + ' days)');
    }

    async stop() {
        if (this._messageHandler) {
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        if (this._tallyTimer) {
            clearInterval(this._tallyTimer);
            this._tallyTimer = null;
        }
    }

    // Compute the block-anchored activation height for a capability MIN_STAKE change. The change
    // can only safely apply after every hub has finalized it, so the earliest valid activation is
    // the current observed block + the voting period (in blocks) + a propagation/apply buffer. An
    // explicit proposer-supplied block is accepted only if it is at or beyond that minimum. Throws
    // if the hub has not observed a block height yet (cannot anchor) or the explicit value is too
    // soon. The returned value is broadcast in the proposal so every hub anchors to the same block.
    _computeActivationBlock(explicit) {
        let raw = this.hub ? this.hub._latestBlockIndex : null;
        if (raw === null || raw === undefined)   // Number(null) === 0 -- must reject explicitly
            throw new Error('cannot anchor a MIN_STAKE change: no observed block height yet');
        let latest = Number(raw);
        if (!Number.isInteger(latest))
            throw new Error('cannot anchor a MIN_STAKE change: no observed block height yet');
        let minActivation = _minActivationBlock(latest, this.votingPeriod);
        if (explicit === undefined || explicit === null) return minActivation;
        let ab = Number(explicit);
        if (!Number.isInteger(ab) || ab < 0)
            throw new Error('invalid activation_block: ' + explicit);
        if (ab < minActivation)
            throw new Error('activation_block ' + ab + ' is too soon (must be >= ' + minActivation +
                ': current block + voting period + safety buffer so every hub finalizes before activation)');
        return ab;
    }

    // Submit a governance proposal. For capability MIN_STAKE parameters
    // (CAPABILITY_<CAP>_MIN_STAKE) an activation block is computed/validated and carried with the
    // proposal so the threshold change is block-anchored federation-wide (#3703); activationBlock
    // is ignored for other parameters (their consumers are not block-anchored).
    async propose(parameter, currentValue, proposedValue, rationale, activationBlock) {
        let proposerPubkey = this.identity ? this.identity.getPubkeyHex() : null;
        if (!proposerPubkey) throw new Error('No validator identity configured');

        let isValidator = this.validatorSet.some(v => v.pubkey === proposerPubkey);
        if (!isValidator) throw new Error('Proposer is not an active validator');

        if (parameter.length > 255)
            throw new Error('parameter name exceeds maximum length of 255 characters');
        if (rationale && rationale.length > 2000)
            throw new Error('rationale exceeds maximum length of 2000 characters');

        let active = await this.db.doQuery(
            "SELECT id FROM governance_proposals WHERE parameter = ? AND status = 'voting'",
            [parameter]
        );
        if (active.length > 0) throw new Error('Active proposal already exists for ' + parameter);

        let rejected = await this.db.doQuery(
            "SELECT voting_end FROM governance_proposals WHERE parameter = ? AND status = 'failed' ORDER BY voting_end DESC LIMIT 1",
            [parameter]
        );
        if (rejected.length > 0) {
            let cooldownEnd = new Date(rejected[0].voting_end).getTime() + (COOLDOWN_DAYS * 86400000);
            if (Date.now() < cooldownEnd) {
                let daysLeft = ((cooldownEnd - Date.now()) / 86400000).toFixed(1);
                throw new Error('Cooldown: ' + daysLeft + ' days remaining before re-proposing ' + parameter);
            }
        }

        this._validateChangeBounds(parameter, currentValue, proposedValue);

        // Pre-launch pin (#4352): refuse to create a CAPABILITY_*_MIN_STAKE proposal. The
        // indexer's on-chain acceptance re-derives quorum from a frozen configs/<COIN>.js
        // constant, so a hub governance MIN_STAKE change would fork the federation from the
        // chain. Move thresholds pre-launch via a coordinated fleet upgrade instead.
        if (MIN_STAKE_GOVERNANCE_DISABLED && parseCapabilityMinStakeParam(parameter))
            throw new Error('CAPABILITY_*_MIN_STAKE governance changes are disabled pre-launch (#4352): the ' +
                'indexer threshold is a frozen consensus constant; change it via a coordinated fleet upgrade of ' +
                'configs/<COIN>.js + HUB_CAPABILITY_CONFIG, not governance');

        // Block-anchor capability MIN_STAKE changes (#3703) and ATTESTATION_PROVIDER
        // config changes (so the LLM fetch/judge model is federation-deterministic at
        // the request's block); other parameters carry no activation block because their
        // consumers are not block-anchored.
        let activation = (parseCapabilityMinStakeParam(parameter) || parseAttestationProviderParam(parameter))
            ? this._computeActivationBlock(activationBlock)
            : null;

        let proposalId = 'gov:' + parameter + ':' + Date.now();
        let now = new Date();
        let votingEnd = new Date(now.getTime() + this.votingPeriod);

        // R2-M2: snapshot-lock the electorate at creation so the tally denominator
        // (and vote-membership) cannot drift with a later setValidatorSet churn.
        let snapshot     = this._buildValidatorSnapshot();
        let snapshotJson = JSON.stringify(snapshot);

        await this.db.doQuery(
            `INSERT INTO governance_proposals
                (proposal_id, proposer_pubkey, parameter, current_value, proposed_value,
                 rationale, status, voting_start, voting_end, activation_block, validator_snapshot)
             VALUES (?, ?, ?, ?, ?, ?, 'voting', ?, ?, ?, ?)`,
            [proposalId, proposerPubkey, parameter, currentValue, proposedValue,
             rationale || '', now, votingEnd, activation, snapshotJson]
        );

        this.peerManager.broadcast(GOV_PROPOSE, {
            proposalId, parameter, currentValue, proposedValue, rationale,
            proposerPubkey, votingEnd: votingEnd.toISOString(), activationBlock: activation,
            validatorSnapshot: snapshot
        });

        console.log('Governance: Proposal created: ' + proposalId + ' (' + parameter + ': ' + currentValue + ' -> ' + proposedValue + ')' +
            (activation !== null ? ' [activation block ' + activation + ']' : ''));

        return { proposalId, parameter, status: 'voting', votingEnd: votingEnd.toISOString(), activationBlock: activation };
    }

    async vote(proposalId, voteChoice) {
        if (!['approve', 'reject'].includes(voteChoice))
            throw new Error('Vote must be "approve" or "reject"');

        let voterPubkey = this.identity ? this.identity.getPubkeyHex() : null;
        if (!voterPubkey) throw new Error('No validator identity configured');

        let isValidatorVoter = this.validatorSet.some(v => v.pubkey === voterPubkey);
        if (!isValidatorVoter) throw new Error('Voter is not an active validator');

        let proposals = await this.db.doQuery(
            "SELECT * FROM governance_proposals WHERE proposal_id = ? AND status = 'voting'",
            [proposalId]
        );
        if (proposals.length === 0) throw new Error('Proposal not found or not in voting state');

        let proposal = proposals[0];
        if (new Date(proposal.voting_end).getTime() < Date.now())
            throw new Error('Voting period has ended');

        // R2-M2: on a snapshot-locked proposal the electorate is the locked set,
        // not whoever is a validator right now, so a validator registered AFTER
        // the proposal was created cannot vote on it (and thus cannot dilute the
        // fixed denominator). Legacy (NULL-snapshot) rows keep the live-set rule.
        let electorate = this._parseSnapshot(proposal.validator_snapshot);
        if (electorate && !electorate.some(e => e.pubkey === String(voterPubkey).toLowerCase()))
            throw new Error('Voter is not in this proposal\'s locked validator set');

        let votePayload = JSON.stringify({ proposalId, vote: voteChoice, voter: voterPubkey });
        let signature = this.identity ? this.identity.sign(votePayload) : '';

        // Record the vote (upsert -- allows changing vote during voting period)
        await this.db.doQuery(
            `INSERT INTO governance_votes (proposal_id, voter_pubkey, vote, signature)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE vote = ?, signature = ?, created_at = NOW()`,
            [proposalId, voterPubkey, voteChoice, signature, voteChoice, signature]
        );

        this.peerManager.broadcast(GOV_VOTE, {
            proposalId, vote: voteChoice, voterPubkey, signature
        });

        console.log('Governance: Vote cast: ' + voteChoice + ' on ' + proposalId);
        return { proposalId, vote: voteChoice, voter: voterPubkey };
    }

    // List proposals, optionally filtered by status and/or parameter name. The
    // parameter filter serves read-only consumers (e.g. the explorer's governance
    // pages) that browse proposals for one governance knob across its history.
    async getProposals(status, parameter, limit) {
        let query = "SELECT * FROM governance_proposals";
        let where = [];
        let args = [];
        if (status) {
            where.push("status = ?");
            args.push(status);
        }
        if (parameter) {
            where.push("parameter = ?");
            args.push(parameter);
        }
        if (where.length) query += " WHERE " + where.join(" AND ");
        let lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
        query += " ORDER BY created_at DESC LIMIT " + lim;
        return await this.db.doQuery(query, args);
    }

    // List individual votes by proposal and/or voter. Read-only surface for the
    // explorer's governance pages; getProposal() already bundles one proposal's
    // votes, but list-by-voter needs its own query. Signature column is omitted
    // (verification happens hub-side at cast time, and rows are hub-local state).
    async getVotes({ proposalId, voterPubkey, limit } = {}) {
        let query = "SELECT id, proposal_id, voter_pubkey, vote, created_at FROM governance_votes";
        let where = [];
        let args = [];
        if (proposalId) {
            where.push("proposal_id = ?");
            args.push(proposalId);
        }
        if (voterPubkey) {
            where.push("voter_pubkey = ?");
            args.push(String(voterPubkey).toLowerCase());
        }
        if (where.length) query += " WHERE " + where.join(" AND ");
        let lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
        query += " ORDER BY id DESC LIMIT " + lim;
        return await this.db.doQuery(query, args);
    }

    async getProposal(proposalId) {
        let proposals = await this.db.doQuery(
            "SELECT * FROM governance_proposals WHERE proposal_id = ?", [proposalId]
        );
        if (proposals.length === 0) return null;

        let votes = await this.db.doQuery(
            "SELECT voter_pubkey, vote, created_at FROM governance_votes WHERE proposal_id = ?",
            [proposalId]
        );

        return { proposal: proposals[0], votes: votes };
    }

    _handleMessage(envelope) {
        switch (envelope.type) {
            case GOV_PROPOSE: this._handlePropose(envelope); break;
            case GOV_VOTE:
                // async (a proposal-window lookup): surface rejections instead of
                // letting them escape the gossip dispatcher as an unhandled rejection.
                this._handleVote(envelope).catch(e =>
                    console.error('Governance: GOV_VOTE handler error:', e && e.message ? e.message : e));
                break;
            case GOV_RESULT:
                // async: a rejection out of the gossip dispatcher would be an
                // unhandled rejection (process exit), so catch and log here.
                this._handleResult(envelope).catch(e =>
                    console.error('Governance: GOV_RESULT handler error:', e && e.message ? e.message : e));
                break;
        }
    }

    _handlePropose(envelope) {
        let { proposalId, parameter, currentValue, proposedValue, rationale, proposerPubkey, activationBlock } = envelope.data;
        if (!proposalId || !parameter) return;

        // Only registered validators may seed a proposal into every hub's DB. Without
        // this gate an authenticated-but-Byzantine peer could stream unbounded distinct
        // proposalIds (unbounded governance_proposals growth on every hub, a DoS), and
        // any non-validator that slips past a null-registry window could inject
        // proposals. Mirrors the _isKnownSender gate on GOV_RESULT / GOV_VOTE.
        if (!this._isKnownSender(envelope.sender)) return;

        // Pre-launch pin (#4352): drop a peer's CAPABILITY_*_MIN_STAKE proposal so this hub
        // never records or votes on it. With no local row, a later GOV_RESULT UPDATE matches
        // 0 rows and never emits proposal:finalized, so the threshold stays pinned.
        if (MIN_STAKE_GOVERNANCE_DISABLED && parseCapabilityMinStakeParam(parameter)) {
            console.warn('Governance: dropping inbound CAPABILITY_*_MIN_STAKE proposal ' + proposalId +
                ' (' + parameter + '); governance MIN_STAKE changes are disabled pre-launch (#4352)');
            return;
        }

        // Persist the proposer-declared activation block for block-anchored parameters
        // (capability MIN_STAKE and ATTESTATION_PROVIDER). Every hub stores the proposer's
        // value so the anchor is federation-uniform (#3703). However, a dishonest proposer
        // could supply an already-past block or one that is far too soon, defeating the
        // safety buffer designed to ensure every hub finalizes before the change activates.
        // Re-validate the min-bound using this hub's local best-observed block height and
        // the same formula as `_computeActivationBlock`. A block that passes the proposer's
        // own validation will always pass here (followers lag the leader's block height by
        // at most a few blocks, and the safety buffer is 50 blocks wide). A forged too-soon
        // block is rejected; the proposal is silently dropped so the network never records it.
        let isBlockAnchored = !!(parseCapabilityMinStakeParam(parameter) || parseAttestationProviderParam(parameter));
        let activation = null;
        if (isBlockAnchored) {
            let raw = this.hub ? this.hub._latestBlockIndex : null;
            let latest = (raw !== null && raw !== undefined) ? Number(raw) : null;
            if (activationBlock === undefined || activationBlock === null || !Number.isInteger(Number(activationBlock))) {
                // Block-anchored parameter arrived with no valid activation block; drop.
                console.warn('Governance: dropping inbound block-anchored proposal ' + proposalId +
                    ' (' + parameter + '): missing or non-integer activation_block');
                return;
            }
            let ab = Number(activationBlock);
            if (latest !== null && Number.isInteger(latest)) {
                let minAb = _minActivationBlock(latest, this.votingPeriod);
                if (ab < minAb) {
                    console.warn('Governance: dropping inbound proposal ' + proposalId +
                        ' (' + parameter + '): activation_block ' + ab + ' is below follower min ' + minAb);
                    return;
                }
            } else {
                // Tipless follower: we have no observed block height to validate the
                // proposer-declared activation_block against. Persisting an unvalidated
                // activation_block could let a dishonest proposer inject a too-soon
                // activation. Drop and wait until the hub has a tip so the min-bound
                // check can run properly.
                console.warn('Governance: dropping inbound block-anchored proposal ' + proposalId +
                    ' (' + parameter + '): cannot validate activation_block ' + ab +
                    ' without a local tip (tipless follower); will re-evaluate when tip is available');
                return;
            }
            activation = ab;
        } else if (activationBlock !== undefined && activationBlock !== null && Number.isInteger(Number(activationBlock))) {
            // Non-block-anchored parameter: persist a peer-supplied activation_block if it
            // happens to be present (for forward compatibility), but do NOT enforce any min.
            activation = Number(activationBlock);
        }

        // Re-validate the change bounds on the follower path, mirroring the
        // activation_block re-check above. propose() enforces them locally, but a
        // Byzantine peer can broadcast a raw GOV_PROPOSE that never went through
        // propose(); without this, every hub records and votes on an out-of-bounds
        // change. Drop it (never record it) so the whole federation ignores it,
        // matching the MIN_STAKE and block-anchor drops above. _validateChangeBounds
        // is a no-op for non-numeric parameters, so only numeric out-of-bounds
        // proposals are affected.
        //
        // DEPLOY NOTE: enforce fleet-wide in one coordinated upgrade. During a
        // mixed-version window, fixed hubs drop an out-of-bounds Byzantine proposal
        // while unfixed hubs persist it, so the two disagree on its existence (and
        // could reach different tally outcomes). Legitimate proposals always pass
        // bounds (propose() validated them), so honest traffic never diverges.
        try {
            this._validateChangeBounds(parameter, currentValue, proposedValue);
        } catch (e) {
            console.warn('Governance: dropping inbound proposal ' + proposalId + ' (' + parameter +
                '): change exceeds allowed bounds: ' + e.message);
            return;
        }

        // Compute voting_end LOCALLY (voting_start = NOW() + votingPeriod) rather than
        // trusting the proposer-supplied wire value (GOV-VOTINGEND-FORGE-1). votingPeriod
        // is a required federation-uniform constant, so every honest hub derives the same
        // window within gossip-delivery skew (seconds), far inside the >=60s tally margin.
        // Trusting the wire value let a single Byzantine validator broadcast a raw
        // GOV_PROPOSE with a far-future votingEnd: the row's voting_end <= NOW() never
        // matches in _checkExpiredProposals, so it is never tallied and never leaves
        // 'voting', and propose() then refuses every honest proposal for that parameter
        // ('Active proposal already exists') -- permanent governance censorship of that
        // knob, repeatable across every parameter. GOV_RESULT also trusts this voting_end
        // in its early-result guard, so a forged future window blocks recovery too.
        let localVotingEnd = new Date(Date.now() + this.votingPeriod);

        // R2-M2: re-validate the proposer's electorate snapshot against THIS hub's
        // own set (never trust it blind -- a Byzantine proposer would ship a
        // self-only snapshot to shrink the denominator to 1-of-1). Exact-set match
        // required, mirroring the activation_block re-validation above. Once the
        // snapshot-lock is active a proposal that omits a valid snapshot is dropped
        // (never recorded), so no unlocked proposal enters the electorate; below
        // activation an invalid/absent snapshot persists as NULL (legacy tally).
        let snap        = this._parseSnapshot(envelope.data.validatorSnapshot);
        let snapValid   = !!snap && this._snapshotMatchesLocalSet(snap);
        if (this._isSnapshotLockActive() && !snapValid) {
            console.warn('Governance: dropping inbound proposal ' + proposalId + ' (' + parameter +
                '): snapshot-lock active but validator_snapshot is missing or does not match the local set');
            return;
        }
        let snapshotJson = snapValid ? JSON.stringify(snap) : null;

        this.db.doQuery(
            `INSERT IGNORE INTO governance_proposals
                (proposal_id, proposer_pubkey, parameter, current_value, proposed_value,
                 rationale, status, voting_start, voting_end, activation_block, validator_snapshot)
             VALUES (?, ?, ?, ?, ?, ?, 'voting', NOW(), ?, ?, ?)`,
            [proposalId, proposerPubkey || '', parameter, currentValue, proposedValue,
             rationale || '', localVotingEnd, activation, snapshotJson]
        ).catch(e => console.error('Governance: failed to persist inbound proposal ' + proposalId + ':', e));
        // INSERT IGNORE already absorbs a duplicate proposal_id without raising, so the only
        // failures reaching here are real (dropped DB connection, deadlock, value-too-long,
        // schema drift). Logging them ties "why didn't node X vote on proposal P?" to its cause.
    }

    async _handleVote(envelope) {
        let { proposalId, vote, voterPubkey, signature } = envelope.data;
        if (!proposalId || !vote || !voterPubkey) return;

        // Authenticate the vote before persisting (consensus-tally-affecting). The
        // table is keyed by (proposal_id, voter_pubkey), so without this ONE validator
        // that passes the transport sig layer could insert a row per FABRICATED
        // voterPubkey and single-handedly meet quorum + approval on any proposal.
        // Authenticate the vote by its OWN signature (like the PBFT engines),
        // independent of the relaying sender:
        //   1. voterPubkey must be a registered validator's signing key, and
        //   2. the ed25519 signature must verify over the canonical vote payload
        //      (byte-identical to what vote() signs), proving the holder of
        //      voterPubkey cast it.
        // An attacker can therefore only ever cast one vote, under its own key -- which
        // it could do legitimately anyway. Membership is checked against validatorSet
        // (the same set the tally denominator is derived from).
        let pk = String(voterPubkey).toLowerCase();
        if (!this.validatorSet.some(v => String(v.pubkey).toLowerCase() === pk)) return;
        let payload = JSON.stringify({ proposalId, vote, voter: voterPubkey });
        if (!ValidatorIdentity.verify(payload, String(signature || ''), voterPubkey)) return;

        // Drop a gossiped vote for a proposal that is not OPEN on this hub (GOV-LATEVOTE-1).
        // The honest vote() path already refuses a vote once voting_end has passed, but this
        // gossip-acceptance path had no such guard, so a validly-signed GOV_VOTE broadcast in
        // the window between voting_end and the leader's tally tick (<= tallyInterval) was
        // upserted and counted, letting a boundary proposal be flipped after its close.
        // Require a local status='voting' row whose voting_end is still in the future; a
        // proposal this hub never recorded (no row) is dropped rather than counted blind.
        let prows;
        try {
            prows = await this.db.doQuery(
                "SELECT voting_end, validator_snapshot FROM governance_proposals WHERE proposal_id = ? AND status = 'voting' LIMIT 1",
                [proposalId]);
        } catch (e) {
            console.error('Governance: failed to look up proposal for inbound vote ' + proposalId + ':', e && e.message ? e.message : e);
            return;
        }
        if (!prows.length || new Date(prows[0].voting_end).getTime() < Date.now()) return;

        // R2-M2: on a snapshot-locked proposal, only a member of the LOCKED set
        // may be counted. The validatorSet gate above admits anyone registered
        // now; a validator added after the proposal opened must not vote on it.
        let electorate = this._parseSnapshot(prows[0].validator_snapshot);
        if (electorate && !electorate.some(e => e.pubkey === pk)) return;

        this.db.doQuery(
            `INSERT INTO governance_votes (proposal_id, voter_pubkey, vote, signature)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE vote = ?, signature = ?, created_at = NOW()`,
            [proposalId, voterPubkey, vote, signature || '', vote, signature || '']
        ).catch(e => console.error('Governance: failed to persist inbound vote for proposal ' + proposalId +
            ' from ' + voterPubkey + ':', e));
        // A vote is consensus-tally-affecting state: a silently-dropped write here makes this
        // node's tally diverge from peers that succeeded, with no symptom until operators
        // compare counts. Log it so a tally mismatch is traceable to the specific dropped write.
    }

    // True if `sender` is a registered validator. Mirrors OracleConsensus._isKnownSender:
    // the P2P sig layer already authenticates the sender, but a forged sender that slipped
    // past a null-registry window must not be trusted. Null registry fails closed; an empty
    // registry stays lenient ONLY until a chain-effective signer set exists
    // (genuine pre-bootstrap, where the sig layer rejects unknowns).
    _isKnownSender(sender) {
        let registry = this.peerManager && this.peerManager.validatorPubkeys;
        if (!registry) return false;
        if (registry.size === 0) {
            // Empty-registry leniency is for the genuine pre-bootstrap window ONLY
            // (G-1/): once the on-chain snapshot has produced a non-empty
            // effective signer set, an empty registry is a misconfiguration or
            // wipe window, not bootstrap, and counting unattributable senders
            // would reopen count-mode quorum forgery. Fail closed instead.
            let signerSet = this.peerManager.effectiveSignerSet;
            return !(signerSet && signerSet.size > 0);
        }
        return registry.has(sender);
    }

    async _handleResult(envelope) {
        let { proposalId, status } = envelope.data;
        if (!proposalId || !status) return;

        // Authenticate the result. GOV_RESULT is the federation-final outcome, applied
        // first-writer-wins under the status='voting' guard below -- so it MUST come only from
        // the proposal's deterministic tally leader (the single hub that runs _tallyProposal).
        // Without this, any one registered validator could broadcast a forged 'passed' that
        // every follower records while the real leader tallies the true outcome locally --
        // a permanent governance split-brain. The tally side is already leader-pinned
        // (_isTallyLeader); this closes the result-ACCEPTANCE side. The leader's own loopback
        // of its broadcast still passes (sender == leader) and is absorbed by the 0-row guard.
        if (!this._isKnownSender(envelope.sender)) return;
        let leader = this._getProposalLeader(proposalId);
        if (!leader || leader.addr !== envelope.sender) return;

        // Reject a result that arrives before the voting window closes: the legitimate leader
        // only tallies after voting_end (_checkExpiredProposals), so an early result is
        // spurious. Compare the LOCALLY-stored voting_end (recorded from GOV_PROPOSE on every
        // hub); a proposal this hub never saw has no row and is dropped rather than applied
        // blind. Safe against clock skew in practice -- the timer-driven tally fires well after
        // voting_end, so a follower receiving the result is already past it too.
        let prows;
        try {
            prows = await this.db.doQuery(
                'SELECT voting_end, validator_snapshot FROM governance_proposals WHERE proposal_id = ? LIMIT 1', [proposalId]);
        } catch (e) { return; }
        if (!prows.length || new Date(prows[0].voting_end).getTime() > Date.now()) return;

        // R2-H2: for a snapshot-locked proposal the wire `status` is a LIVENESS
        // TRIGGER, not an oracle. A validator that grinds `proposalId` (it embeds
        // Date.now()) to make itself the deterministic leader could otherwise
        // broadcast 'passed' with zero approvals and every follower would record
        // it. Instead: ingest the leader's authenticated vote evidence (recovers
        // any GOV_VOTE gossip this follower missed), re-tally LOCALLY against the
        // locked electorate, and apply the local result. Legacy (NULL-snapshot)
        // rows keep the historical apply-wire-status behaviour (re-tallying them
        // against a per-hub-divergent live set would itself fork; this is why
        // R2-M2 gates R2-H2).
        let electorate  = this._parseSnapshot(prows[0].validator_snapshot);
        let applyStatus = status;
        if (electorate) {
            await this._ingestResultVotes(proposalId, envelope.data.votes, electorate);
            let votes;
            try {
                votes = await this.db.doQuery(
                    "SELECT voter_pubkey, vote FROM governance_votes WHERE proposal_id = ?", [proposalId]);
            } catch (e) { return; }
            let localResult = this._computeTally(votes, electorate).approved ? 'passed' : 'failed';
            if (localResult !== status) {
                console.warn('Governance: GOV_RESULT status mismatch from leader ' + envelope.sender +
                    ' on ' + proposalId + ': wire=' + status + ' local=' + localResult +
                    ' (applying local re-tally)');
            }
            applyStatus = localResult;
        }

        // Update proposal status locally. Guard side effects on the status-transition (was 'voting')
        // so the tally leader's own loopback of this GOV_RESULT -- which already applied + emitted in
        // _tallyProposal -- affects 0 rows here and does not double-emit.
        let res;
        try {
            res = await this.db.doQuery(
                "UPDATE governance_proposals SET status = ?, applied_at = NOW() WHERE proposal_id = ? AND status = 'voting'",
                [applyStatus, proposalId]
            );
        } catch (e) { return; }

        // A passed proposal's 'proposal:finalized' listeners (capability hot-reload, provider
        // registry) are registered on EVERY hub, but _tallyProposal only runs on the deterministic
        // tally leader -- so without emitting here followers update the row yet never APPLY the
        // change, and capability thresholds (min_stake etc.) diverge federation-wide until restart.
        // Emit on the same transition + payload shape the leader uses in _tallyProposal.
        if (applyStatus === 'passed' && res && res.affectedRows > 0) {
            try {
                let rows = await this.db.doQuery(
                    'SELECT parameter, current_value, proposed_value, activation_block FROM governance_proposals WHERE proposal_id = ? LIMIT 1',
                    [proposalId]
                );
                if (rows.length) {
                    this.emit('proposal:finalized', {
                        proposalId: proposalId,
                        parameter:  rows[0].parameter,
                        oldValue:   rows[0].current_value,
                        newValue:   rows[0].proposed_value,
                        activationBlock: rows[0].activation_block
                    });
                }
            } catch (e) { /* best-effort: status already persisted */ }
        }
    }

    // R2-H2: ingest the vote evidence carried on GOV_RESULT so a follower that
    // missed some GOV_VOTE gossip can still reproduce the leader's tally. Each
    // entry is self-authenticating and independently checked (never trusted
    // because the leader relayed it): the voter must be in the locked electorate,
    // and its ed25519 signature must verify over the exact canonical payload
    // vote()/_handleVote sign. Upsert is idempotent, so the leader's own loopback
    // and duplicate deliveries are harmless. A malformed/oversized `votes` array
    // is skipped (the local re-tally still runs on whatever votes we already hold).
    async _ingestResultVotes(proposalId, wireVotes, electorate) {
        if (!Array.isArray(wireVotes) || wireVotes.length > GOV_SNAPSHOT_MAX_VALIDATORS) return;
        let members = new Set(electorate.map(e => e.pubkey));
        for (let v of wireVotes) {
            if (!v || typeof v.voterPubkey !== 'string' || (v.vote !== 'approve' && v.vote !== 'reject')) continue;
            let pk = v.voterPubkey.toLowerCase();
            if (!members.has(pk)) continue;
            let payload = JSON.stringify({ proposalId, vote: v.vote, voter: v.voterPubkey });
            if (!ValidatorIdentity.verify(payload, String(v.signature || ''), v.voterPubkey)) continue;
            try {
                await this.db.doQuery(
                    `INSERT INTO governance_votes (proposal_id, voter_pubkey, vote, signature)
                     VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE vote = ?, signature = ?, created_at = NOW()`,
                    [proposalId, v.voterPubkey, v.vote, String(v.signature || ''), v.vote, String(v.signature || '')]
                );
            } catch (e) {
                console.error('Governance: failed to ingest GOV_RESULT vote evidence for ' + proposalId +
                    ' from ' + v.voterPubkey + ':', e && e.message ? e.message : e);
            }
        }
    }

    // Deterministic leader for a proposal. Mirrors OracleConsensus._getLeader
    // (modular index into the validator set) but, since governance has no
    // sequential round counter, derives the round from a hash of the immutable
    // proposal_id. Every hub computes the same leader for a given proposal.
    _getProposalLeader(proposalId) {
        if (this.validatorSet.length === 0) return null;
        let round = crypto.createHash('sha256').update(proposalId).digest().readUInt32BE(0);
        return this.validatorSet[round % this.validatorSet.length];
    }

    // True if this hub is the deterministic leader responsible for tallying the
    // given proposal. A hub with no validator set (standalone / dev) falls back
    // to tallying locally so single-node operation is unaffected.
    _isTallyLeader(proposalId) {
        if (this.validatorSet.length === 0) return true;
        let leader = this._getProposalLeader(proposalId);
        return !!leader && leader.addr === this.peerManager.validatorAddr;
    }

    // Check for proposals whose voting period has ended and tally them
    async _checkExpiredProposals() {
        let expired;
        try {
            expired = await this.db.doQuery(
                "SELECT * FROM governance_proposals WHERE status = 'voting' AND voting_end <= NOW()"
            );
        } catch (e) {
            // Tally check runs on a timer, so don't crash -- but log the error.
            // A systematic failure here (schema drift, column mismatch) would
            // otherwise freeze every proposal in 'voting' state with no signal.
            console.error('Governance tally error:', e.message, e);
            return;
        }

        for (let proposal of expired) {
            // Only the deterministic leader for this proposal tallies and
            // broadcasts the result; followers accept the GOV_RESULT broadcast
            // as authoritative. This prevents two hubs from independently
            // tallying with different gossip-delivered vote counts and reaching
            // contradictory passed/failed conclusions (split-brain).
            if (!this._isTallyLeader(proposal.proposal_id)) continue;
            try {
                await this._tallyProposal(proposal);
            } catch (e) {
                console.error('Governance: tally failed for proposal ' + proposal.proposal_id + ':', e);
            }
        }
    }

    async _tallyProposal(proposal) {
        // R2-M2: include the signature so followers can re-verify each vote when
        // they re-tally locally (R2-H2), not accept the leader's status blind.
        let votes = await this.db.doQuery(
            "SELECT voter_pubkey, vote, signature FROM governance_votes WHERE proposal_id = ?",
            [proposal.proposal_id]
        );

        // R2-M2: tally against the proposal's LOCKED electorate (snapshot), not the
        // live mutable validatorSet, so a set churn mid-vote cannot move the
        // denominator. Legacy (NULL-snapshot) rows fall back to the live set.
        let electorate = this._parseSnapshot(proposal.validator_snapshot);
        let tally = this._computeTally(votes, electorate);
        let { approvals, rejections, totalVotes, validatorCount, approved } = tally;

        let newStatus = approved ? 'passed' : 'failed';

        // Gate the broadcast + emit on the status transition actually landing on THIS
        // row. setInterval(_checkExpiredProposals) does not await its async pass, so a
        // slow DB lets the next tick re-select the still-'voting' proposal and re-tally
        // it; the status='voting' WHERE clause makes only one UPDATE affect a row, but
        // without this affectedRows check both passes would broadcast GOV_RESULT and
        // emit proposal:finalized, double-applying on the leader. Mirrors _handleResult.
        let res = await this.db.doQuery(
            "UPDATE governance_proposals SET status = ?, applied_at = NOW() WHERE proposal_id = ? AND status = 'voting'",
            [newStatus, proposal.proposal_id]
        );
        if (!res || !res.affectedRows) return;

        this.peerManager.broadcast(GOV_RESULT, {
            proposalId: proposal.proposal_id,
            status: newStatus,
            approvals, rejections, totalVotes, validatorCount,
            // R2-H2: carry the authenticated vote evidence so a follower that
            // missed some GOV_VOTE gossip can reproduce this exact tally locally
            // and NEVER apply the wire status on faith. Each entry re-verifies on
            // the receive side (membership in the locked snapshot + ed25519 sig).
            // Bounded by the snapshot cap. Old hubs ignore the extra field.
            votes: votes.map(v => ({ voterPubkey: v.voter_pubkey, vote: v.vote, signature: v.signature }))
        });

        console.log('Governance: Proposal ' + proposal.proposal_id + ': ' + newStatus +
            ' (' + approvals + '/' + totalVotes + ' approve, ' + validatorCount + ' validators)');

        if (approved) {
            this.emit('proposal:finalized', {
                proposalId: proposal.proposal_id,
                parameter:  proposal.parameter,
                oldValue:   proposal.current_value,
                newValue:   proposal.proposed_value,
                activationBlock: proposal.activation_block
            });
        }
    }

    _validateChangeBounds(parameter, currentValue, proposedValue) {
        // Only validate numeric parameters
        let cur  = parseDecimalParts(currentValue);
        let prop = parseDecimalParts(proposedValue);
        if (!cur || !prop) return;

        let scale = Math.max(cur.frac.length, prop.frac.length);
        let C = toScaledBigInt(cur, scale);
        let P = toScaledBigInt(prop, scale);
        if (C === 0n) return;

        let isSlashParam = SLASHING_PARAMS.includes(parameter);
        let maxIncrease = isSlashParam ? MAX_SLASH_INCREASE : MAX_INCREASE;
        let maxDecrease = isSlashParam ? MAX_SLASH_DECREASE : MAX_DECREASE;

        // changeRatio = (P - C) / C, evaluated exactly via cross-multiplication so
        // large parameter values aren't rounded by float64. The thresholds are
        // whole-percent, so express them as integer percentages and compare
        // N*100 against pct*C. Multiplying through by C flips the inequality when
        // C < 0, which preserves the original sign-sensitive behaviour.
        let N      = P - C;
        let n100   = N * 100n;
        let incPct = BigInt(Math.round(maxIncrease * 100));
        let decPct = BigInt(Math.round(maxDecrease * 100));
        let positive = C > 0n;
        let exceedsIncrease = positive ? (n100 > incPct * C) : (n100 < incPct * C);
        let exceedsDecrease = positive ? (n100 < -decPct * C) : (n100 > -decPct * C);

        // Float ratio is fine for the human-readable percentage in the message.
        let changeRatio = Number(N) / Number(C);

        if (exceedsIncrease) {
            throw new Error('Proposed increase (' + (changeRatio * 100).toFixed(1) + '%) exceeds maximum (' + (maxIncrease * 100) + '%)');
        }
        if (exceedsDecrease) {
            throw new Error('Proposed decrease (' + (Math.abs(changeRatio) * 100).toFixed(1) + '%) exceeds maximum (' + (maxDecrease * 100) + '%)');
        }
    }
}

module.exports = Governance;
