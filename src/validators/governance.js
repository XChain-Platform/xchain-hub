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

const EventEmitter = require('events');
const { parseCapabilityMinStakeParam, MIN_STAKE_GOVERNANCE_DISABLED } = require('./capability_registry.js');
const { parseAttestationProviderParam } = require('./provider_registry.js');
const { canonicalValidatorOrder } = require('../rollcall/validator_order.js');
const { GOV_PROPOSE, GOV_VOTE, GOV_RESULT, COOLDOWN_DAYS,
        voteSigningPayload, normalizeVoteSeq, minActivationBlock } = require('./governance/rules.js');
// The engine's own behaviour, split by the question each part answers and installed
// on the prototype below, the same non-enumerable way src/db/index.js installs its
// mixins: who may vote and how votes are counted, the three inbound wire paths, the
// tally, and the bounds a change is measured against.
const electorateMixin     = require('./governance/electorate.js');
const proposeInboundMixin = require('./governance/propose_inbound.js');
const voteInboundMixin    = require('./governance/vote_inbound.js');
const resultInboundMixin  = require('./governance/result_inbound.js');
const tallyMixin          = require('./governance/tally.js');
const boundsMixin         = require('./governance/bounds.js');
const hubConfig = require('../config');
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();

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

        this.votingPeriod  = parseInt(hubConfig.GOV_VOTING_PERIOD)       || (7 * 24 * 60 * 60 * 1000); // 7 days
        this.tallyInterval = parseInt(hubConfig.GOVERNANCE_TALLY_INTERVAL) || 60000;
    }

    // Canonicalize the set's ORDER on the way in, so
    // getProposalLeader (`validatorSet[hash(proposalId) % N]`) picks the same
    // tally leader on every hub for identical membership. Membership checks
    // and buildValidatorSnapshot are unaffected: the former is order-blind and
    // the latter already sorted by pubkey. See validator_order.js.
    setValidatorSet(validators) {
        this.validatorSet = canonicalValidatorOrder(validators);
    }

    async start() {
        this._messageHandler = (envelope) => this.handleMessage(envelope);
        this.peerManager.on('message', this._messageHandler);

        // Catch the tick's rejection, the same idiom every other periodic loop in the
        // hub uses. checkExpiredProposals guards its two awaits but not the leader
        // check between them, so a data fault there (an unorderable proposal_id, a
        // non-iterable result row set) rejects the tick's promise. The hub registers no
        // process.on('unhandledRejection'), and Node's default turns an unhandled
        // rejection into process death, so without this a per-tick fault kills the hub
        // instead of logging and re-arming, which is what the tally path intends.
        this._tallyTimer = setInterval(() => {
            this.checkExpiredProposals().catch(e => logger.error(nodeUtil.format('Governance tally tick error:', e)));
        }, this.tallyInterval);

        logger.info('Governance engine started (voting period: ' + (this.votingPeriod / 86400000).toFixed(1) + ' days)');
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
    computeActivationBlock(explicit) {
        let raw = this.hub ? this.hub._latestBlockIndex : null;
        if (raw === null || raw === undefined)   // Number(null) === 0 -- must reject explicitly
            throw new Error('cannot anchor a MIN_STAKE change: no observed block height yet');
        let latest = Number(raw);
        if (!Number.isInteger(latest))
            throw new Error('cannot anchor a MIN_STAKE change: no observed block height yet');
        let minActivation = minActivationBlock(latest, this.votingPeriod);
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
    // Everything propose() refuses BEFORE it writes a row, in the order it refused
    // them when this was one method: an identity and membership this hub can stand
    // behind, the two length bounds the columns impose, the one-active-per-parameter
    // rule, the re-proposal cooldown, the change bounds, and the pre-launch MIN_STAKE
    // pin. Every one throws, so a caller that reaches the line after this call has a
    // proposal the hub is willing to broadcast. Returns the proposer's pubkey, which
    // is the one value the checks resolve on the way.
    async assertProposable(parameter, currentValue, proposedValue, rationale) {
        let proposerPubkey = this.identity ? this.identity.getPubkeyHex() : null;
        if (!proposerPubkey) throw new Error('No validator identity configured');

        let isValidator = this.validatorSet.some(v => v.pubkey === proposerPubkey);
        if (!isValidator) throw new Error('Proposer is not an active validator');

        if (parameter.length > 255)
            throw new Error('parameter name exceeds maximum length of 255 characters');
        if (rationale && rationale.length > 2000)
            throw new Error('rationale exceeds maximum length of 2000 characters');

        let active = await this.db.findGovernanceProposalsByParameter(parameter);
        if (active.length > 0) throw new Error('Active proposal already exists for ' + parameter);

        let rejected = await this.db.getGovernanceProposalByParameter(parameter);
        if (rejected.length > 0) {
            let cooldownEnd = new Date(rejected[0].voting_end).getTime() + (COOLDOWN_DAYS * 86400000);
            if (Date.now() < cooldownEnd) {
                let daysLeft = ((cooldownEnd - Date.now()) / 86400000).toFixed(1);
                throw new Error('Cooldown: ' + daysLeft + ' days remaining before re-proposing ' + parameter);
            }
        }

        this.validateChangeBounds(parameter, currentValue, proposedValue);

        // Pre-launch pin (#4352): refuse to create a CAPABILITY_*_MIN_STAKE proposal. The
        // indexer's on-chain acceptance re-derives quorum from a frozen configs/<COIN>.js
        // constant, so a hub governance MIN_STAKE change would fork the federation from the
        // chain. Move thresholds pre-launch via a coordinated fleet upgrade instead.
        if (MIN_STAKE_GOVERNANCE_DISABLED && parseCapabilityMinStakeParam(parameter))
            throw new Error('CAPABILITY_*_MIN_STAKE governance changes are disabled pre-launch (#4352): the ' +
                'indexer threshold is a frozen consensus constant; change it via a coordinated fleet upgrade of ' +
                'configs/<COIN>.js + HUB_CAPABILITY_CONFIG, not governance');

        return proposerPubkey;
    }

    async propose(parameter, currentValue, proposedValue, rationale, activationBlock) {
        let proposerPubkey = await this.assertProposable(parameter, currentValue, proposedValue, rationale);

        // Block-anchor capability MIN_STAKE changes (#3703) and ATTESTATION_PROVIDER
        // config changes (so the LLM fetch/judge model is federation-deterministic at
        // the request's block); other parameters carry no activation block because their
        // consumers are not block-anchored.
        let activation = (parseCapabilityMinStakeParam(parameter) || parseAttestationProviderParam(parameter))
            ? this.computeActivationBlock(activationBlock)
            : null;

        let proposalId = 'gov:' + parameter + ':' + Date.now();
        let now = new Date();
        let votingEnd = new Date(now.getTime() + this.votingPeriod);

        // R2-M2: snapshot-lock the electorate at creation so the tally denominator
        // (and vote-membership) cannot drift with a later setValidatorSet churn.
        let snapshot     = this.buildValidatorSnapshot();
        let snapshotJson = JSON.stringify(snapshot);

        await this.db.createGovernanceProposalByProposalId(proposalId, proposerPubkey, parameter, currentValue, proposedValue, rationale || '', now, votingEnd, activation, snapshotJson);

        this.peerManager.broadcast(GOV_PROPOSE, {
            proposalId, parameter, currentValue, proposedValue, rationale,
            proposerPubkey, votingEnd: votingEnd.toISOString(), activationBlock: activation,
            validatorSnapshot: snapshot
        });

        logger.info('Governance: Proposal created: ' + proposalId + ' (' + parameter + ': ' + currentValue + ' -> ' + proposedValue + ')' +
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

        let proposals = await this.db.findGovernanceProposalsByProposalIdInVoting(proposalId);
        if (proposals.length === 0) throw new Error('Proposal not found or not in voting state');

        let proposal = proposals[0];
        if (new Date(proposal.voting_end).getTime() < Date.now())
            throw new Error('Voting period has ended');

        // R2-M2: on a snapshot-locked proposal the electorate is the locked set,
        // not whoever is a validator right now, so a validator registered AFTER
        // the proposal was created cannot vote on it (and thus cannot dilute the
        // fixed denominator). Legacy (NULL-snapshot) rows keep the live-set rule.
        let electorate = this.parseSnapshot(proposal.validator_snapshot);
        if (electorate && !electorate.some(e => e.pubkey === String(voterPubkey).toLowerCase()))
            throw new Error('Voter is not in this proposal\'s locked validator set');

        // GOV-VOTE-REPLAY-1: stamp a monotonic seq into the signed bytes. The wall
        // clock is the source, floored to strictly beat whatever this voter already
        // has stored for this proposal: two votes inside one millisecond, or a clock
        // that stepped backwards, would otherwise tie and be refused as
        // non-increasing, leaving the voter unable to change their vote.
        let priorSeq = 0;
        let priorRows = await this.db.getGovernanceVote(proposalId, voterPubkey) || [];
        if (priorRows.length) priorSeq = normalizeVoteSeq(Number(priorRows[0].vote_seq));
        let seq = Math.max(Date.now(), priorSeq + 1);

        let votePayload = voteSigningPayload(proposalId, voteChoice, voterPubkey, seq);
        let signature = this.identity ? this.identity.sign(votePayload) : '';

        // Record the vote (upsert -- allows changing vote during voting period,
        // but only ever forward: upsertVote refuses a non-increasing seq)
        await this.upsertVote(proposalId, voterPubkey, voteChoice, signature, seq);

        this.peerManager.broadcast(GOV_VOTE, {
            proposalId, vote: voteChoice, voterPubkey, signature, seq
        });

        logger.info('Governance: Vote cast: ' + voteChoice + ' on ' + proposalId);
        return { proposalId, vote: voteChoice, voter: voterPubkey };
    }

    // List proposals, optionally filtered by status and/or parameter name. The
    // parameter filter serves read-only consumers (e.g. the explorer's governance
    // pages) that browse proposals for one governance knob across its history.
    async getProposals(status, parameter, limit) {
        return await this.db.findGovernanceProposalsFiltered(status, parameter, limit);
    }

    // List individual votes by proposal and/or voter. Read-only surface for the
    // explorer's governance pages; getProposal() already bundles one proposal's
    // votes, but list-by-voter needs its own query. Signature column is omitted
    // (verification happens hub-side at cast time, and rows are hub-local state).
    async getVotes({ proposalId, voterPubkey, limit } = {}) {
        return await this.db.findGovernanceVotesFiltered({
            proposalId,
            voterPubkey: voterPubkey ? String(voterPubkey).toLowerCase() : voterPubkey,
            limit
        });
    }

    async getProposal(proposalId) {
        let proposals = await this.db.findGovernanceProposalsByProposalId(proposalId);
        if (proposals.length === 0) return null;

        let votes = await this.db.findGovernanceVotesWithCreatedAt(proposalId);

        return { proposal: proposals[0], votes: votes };
    }

    handleMessage(envelope) {
        switch (envelope.type) {
            case GOV_PROPOSE:
                // async (a cooldown-window DB lookup): surface rejections instead of
                // letting them escape the gossip dispatcher as an unhandled rejection.
                this.handlePropose(envelope).catch(e =>
                    logger.error(nodeUtil.format('Governance: GOV_PROPOSE handler error:', e && e.message ? e.message : e)));
                break;
            case GOV_VOTE:
                // async (a proposal-window lookup): surface rejections instead of
                // letting them escape the gossip dispatcher as an unhandled rejection.
                this.handleVote(envelope).catch(e =>
                    logger.error(nodeUtil.format('Governance: GOV_VOTE handler error:', e && e.message ? e.message : e)));
                break;
            case GOV_RESULT:
                // async: a rejection out of the gossip dispatcher would be an
                // unhandled rejection (process exit), so catch and log here.
                this.handleResult(envelope).catch(e =>
                    logger.error(nodeUtil.format('Governance: GOV_RESULT handler error:', e && e.message ? e.message : e)));
                break;
        }
    }

}

// One mixin's methods on the prototype, non-enumerably, exactly as src/db/index.js
// installs its own: class methods are non-enumerable, so an assigned mixin would be
// the only prototype member for...in and Object.keys(Governance.prototype) could
// see, which is behaviour rather than layout. writable and configurable stay true so
// a suite can stub a moved method and put it back. A name already on the prototype
// throws at load rather than overwriting silently.
function installMixins(target, mixins) {
    for (const mixin of mixins) {
        const descriptors = {};
        for (const name of Object.keys(mixin)) {
            if (Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('Duplicate Governance method: ' + name + ' is already defined on ' +
                    'Governance.prototype. Two governance mixins, or a mixin and the class, claim the same name.');
            descriptors[name] = { value: mixin[name], enumerable: false, writable: true, configurable: true };
        }
        Object.defineProperties(target, descriptors);
    }
}

installMixins(Governance.prototype, [
    electorateMixin, proposeInboundMixin, voteInboundMixin, resultInboundMixin, tallyMixin, boundsMixin
]);

module.exports = Object.assign(Governance, {
    // Exported for the unit suite. GOV-VOTE-REPLAY-1 lives entirely in these two
    // functions, and a test that rebuilt the signed bytes itself would keep passing
    // even if production drifted away from it, so the suite must use these.
    voteSigningPayload,
    normalizeVoteSeq
});
