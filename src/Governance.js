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

        // Validator set
        this.validatorSet = [];

        // Message handler
        this._messageHandler = null;

        // Tally check timer
        this._tallyTimer = null;

        // Config
        this.votingPeriod  = parseInt(process.env.GOV_VOTING_PERIOD)       || (7 * 24 * 60 * 60 * 1000); // 7 days
        this.tallyInterval = parseInt(process.env.GOVERNANCE_TALLY_INTERVAL) || 60000;
    }

    setValidatorSet(validators) {
        this.validatorSet = validators;
    }

    async start() {
        this._messageHandler = (envelope) => this._handleMessage(envelope);
        this.peerManager.on('message', this._messageHandler);

        // Periodically check for proposals that need tallying
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
        // Validate proposer is an active validator
        let proposerPubkey = this.identity ? this.identity.getPubkeyHex() : null;
        if (!proposerPubkey) throw new Error('No validator identity configured');

        let isValidator = this.validatorSet.some(v => v.pubkey === proposerPubkey);
        if (!isValidator) throw new Error('Proposer is not an active validator');

        // Validate parameter name and rationale length
        if (parameter.length > 255)
            throw new Error('parameter name exceeds maximum length of 255 characters');
        if (rationale && rationale.length > 2000)
            throw new Error('rationale exceeds maximum length of 2000 characters');

        // Check for active proposal on the same parameter
        let active = await this.db.doQuery(
            "SELECT id FROM governance_proposals WHERE parameter = ? AND status = 'voting'",
            [parameter]
        );
        if (active.length > 0) throw new Error('Active proposal already exists for ' + parameter);

        // Check cooldown from recent rejection
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

        // Validate change bounds
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

        // Create the proposal
        let proposalId = 'gov:' + parameter + ':' + Date.now();
        let now = new Date();
        let votingEnd = new Date(now.getTime() + this.votingPeriod);

        await this.db.doQuery(
            `INSERT INTO governance_proposals
                (proposal_id, proposer_pubkey, parameter, current_value, proposed_value,
                 rationale, status, voting_start, voting_end, activation_block)
             VALUES (?, ?, ?, ?, ?, ?, 'voting', ?, ?, ?)`,
            [proposalId, proposerPubkey, parameter, currentValue, proposedValue,
             rationale || '', now, votingEnd, activation]
        );

        // Broadcast the proposal
        this.peerManager.broadcast(GOV_PROPOSE, {
            proposalId, parameter, currentValue, proposedValue, rationale,
            proposerPubkey, votingEnd: votingEnd.toISOString(), activationBlock: activation
        });

        console.log('Governance: Proposal created: ' + proposalId + ' (' + parameter + ': ' + currentValue + ' -> ' + proposedValue + ')' +
            (activation !== null ? ' [activation block ' + activation + ']' : ''));

        return { proposalId, parameter, status: 'voting', votingEnd: votingEnd.toISOString(), activationBlock: activation };
    }

    // Cast a vote on a proposal
    async vote(proposalId, voteChoice) {
        if (!['approve', 'reject'].includes(voteChoice))
            throw new Error('Vote must be "approve" or "reject"');

        let voterPubkey = this.identity ? this.identity.getPubkeyHex() : null;
        if (!voterPubkey) throw new Error('No validator identity configured');

        let isValidatorVoter = this.validatorSet.some(v => v.pubkey === voterPubkey);
        if (!isValidatorVoter) throw new Error('Voter is not an active validator');

        // Verify proposal exists and is in voting state
        let proposals = await this.db.doQuery(
            "SELECT * FROM governance_proposals WHERE proposal_id = ? AND status = 'voting'",
            [proposalId]
        );
        if (proposals.length === 0) throw new Error('Proposal not found or not in voting state');

        // Check voting period hasn't ended
        let proposal = proposals[0];
        if (new Date(proposal.voting_end).getTime() < Date.now())
            throw new Error('Voting period has ended');

        // Sign the vote
        let votePayload = JSON.stringify({ proposalId, vote: voteChoice, voter: voterPubkey });
        let signature = this.identity ? this.identity.sign(votePayload) : '';

        // Record the vote (upsert -- allows changing vote during voting period)
        await this.db.doQuery(
            `INSERT INTO governance_votes (proposal_id, voter_pubkey, vote, signature)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE vote = ?, signature = ?, created_at = NOW()`,
            [proposalId, voterPubkey, voteChoice, signature, voteChoice, signature]
        );

        // Broadcast the vote
        this.peerManager.broadcast(GOV_VOTE, {
            proposalId, vote: voteChoice, voterPubkey, signature
        });

        console.log('Governance: Vote cast: ' + voteChoice + ' on ' + proposalId);
        return { proposalId, vote: voteChoice, voter: voterPubkey };
    }

    // Get proposals by status
    async getProposals(status) {
        let query = "SELECT * FROM governance_proposals";
        let args = [];
        if (status) {
            query += " WHERE status = ?";
            args.push(status);
        }
        query += " ORDER BY created_at DESC LIMIT 50";
        return await this.db.doQuery(query, args);
    }

    // Get a specific proposal with its votes
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

    // --- Message handlers ---

    _handleMessage(envelope) {
        switch (envelope.type) {
            case GOV_PROPOSE: this._handlePropose(envelope); break;
            case GOV_VOTE:    this._handleVote(envelope);    break;
            case GOV_RESULT:  this._handleResult(envelope);  break;
        }
    }

    _handlePropose(envelope) {
        let { proposalId, parameter, currentValue, proposedValue, rationale, proposerPubkey, votingEnd, activationBlock } = envelope.data;
        if (!proposalId || !parameter) return;

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
            }
            activation = ab;
        } else if (activationBlock !== undefined && activationBlock !== null && Number.isInteger(Number(activationBlock))) {
            // Non-block-anchored parameter: persist a peer-supplied activation_block if it
            // happens to be present (for forward compatibility), but do NOT enforce any min.
            activation = Number(activationBlock);
        }

        // Store the proposal locally if we don't have it
        this.db.doQuery(
            `INSERT IGNORE INTO governance_proposals
                (proposal_id, proposer_pubkey, parameter, current_value, proposed_value,
                 rationale, status, voting_start, voting_end, activation_block)
             VALUES (?, ?, ?, ?, ?, ?, 'voting', NOW(), ?, ?)`,
            [proposalId, proposerPubkey || '', parameter, currentValue, proposedValue,
             rationale || '', votingEnd, activation]
        ).catch(e => {}); // Ignore duplicate
    }

    _handleVote(envelope) {
        let { proposalId, vote, voterPubkey, signature } = envelope.data;
        if (!proposalId || !vote || !voterPubkey) return;

        // Store the vote locally
        this.db.doQuery(
            `INSERT INTO governance_votes (proposal_id, voter_pubkey, vote, signature)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE vote = ?, signature = ?, created_at = NOW()`,
            [proposalId, voterPubkey, vote, signature || '', vote, signature || '']
        ).catch(e => {}); // Ignore errors
    }

    // True if `sender` is a registered validator. Mirrors OracleConsensus._isKnownSender:
    // the P2P sig layer already authenticates the sender, but a forged sender that slipped
    // past a null-registry window must not be trusted. Null registry fails closed; an empty
    // registry stays lenient (genuine pre-bootstrap, where the sig layer rejects unknowns).
    _isKnownSender(sender) {
        let registry = this.peerManager && this.peerManager.validatorPubkeys;
        if (!registry) return false;
        if (registry.size === 0) return true;
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
                'SELECT voting_end FROM governance_proposals WHERE proposal_id = ? LIMIT 1', [proposalId]);
        } catch (e) { return; }
        if (!prows.length || new Date(prows[0].voting_end).getTime() > Date.now()) return;

        // Update proposal status locally. Guard side effects on the status-transition (was 'voting')
        // so the tally leader's own loopback of this GOV_RESULT -- which already applied + emitted in
        // _tallyProposal -- affects 0 rows here and does not double-emit.
        let res;
        try {
            res = await this.db.doQuery(
                "UPDATE governance_proposals SET status = ?, applied_at = NOW() WHERE proposal_id = ? AND status = 'voting'",
                [status, proposalId]
            );
        } catch (e) { return; }

        // A passed proposal's 'proposal:finalized' listeners (capability hot-reload, provider
        // registry) are registered on EVERY hub, but _tallyProposal only runs on the deterministic
        // tally leader -- so without emitting here followers update the row yet never APPLY the
        // change, and capability thresholds (min_stake etc.) diverge federation-wide until restart.
        // Emit on the same transition + payload shape the leader uses in _tallyProposal.
        if (status === 'passed' && res && res.affectedRows > 0) {
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

    // --- Tally logic ---

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
        // Get all votes for this proposal
        let votes = await this.db.doQuery(
            "SELECT voter_pubkey, vote FROM governance_votes WHERE proposal_id = ?",
            [proposal.proposal_id]
        );

        let approvals = votes.filter(v => v.vote === 'approve').length;
        let rejections = votes.filter(v => v.vote === 'reject').length;
        let totalVotes = votes.length;
        let validatorCount = Math.max(this.validatorSet.length, 1);

        // Check quorum (50% minimum participation)
        let quorumMet = totalVotes >= Math.ceil(validatorCount / 2);

        // Check 2/3+ approval
        let approved = quorumMet && approvals >= Math.ceil(validatorCount * 2 / 3);

        let newStatus = approved ? 'passed' : 'failed';

        await this.db.doQuery(
            "UPDATE governance_proposals SET status = ?, applied_at = NOW() WHERE proposal_id = ? AND status = 'voting'",
            [newStatus, proposal.proposal_id]
        );

        // Broadcast the result
        this.peerManager.broadcast(GOV_RESULT, {
            proposalId: proposal.proposal_id,
            status: newStatus,
            approvals, rejections, totalVotes, validatorCount
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

    // --- Validation ---

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
