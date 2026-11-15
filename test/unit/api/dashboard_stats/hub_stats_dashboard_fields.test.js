'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The anchor, checkpoint, attestation and cross-chain stats fields
// xchain-dashboard's alert path reads, pinned where a rename would happen.
//
// The dashboard turns a missing counter into "no reading" on purpose (an older
// hub lacks it), so a hub rename or drop silences the matching detector with no
// rail failure on either side. This file fails in hub CI instead.
//
// Consumers (xchain-dashboard plugins/monitor/src/lib/alerts): rules/anchor_publisher.js,
// rules/attestations.js, rules/checkpoints.js, rules/cross_chain.js and
// evaluator-conditions-hub.js. Add a key here when the dashboard starts reading
// one; pin presence only, because null is a legitimate value for most of them.

const sinon                 = require('sinon');
const { expect }            = require('chai');
const StateAnchorPublisher  = require('../../../../src/anchor/publisher');
const StateCheckpointEngine = require('../../../../src/anchor/checkpoint_engine');
const AttestationRound      = require('../../../../src/attestation/round');
const AttestationConsensus  = require('../../../../src/attestation/consensus');
const CrossChainCallEngine  = require('../../../../src/cross_chain/call_engine');
const ValidatorIdentity     = require('../../../../src/validators/identity');
const { buildAnchorRpc }      = require('../../../../src/api/rpc/anchor');
const { buildAttestationRpc } = require('../../../../src/api/rpc/attestation');
const { buildCrossChainRpc }  = require('../../../../src/api/rpc/cross_chain');
const { createMockHub, DB_METHODS } = require('../../../helpers/mockHub');

const ANCHOR_KEYS = [
    'active', 'enabled', 'allowUnconfirmedInputs', 'confirmedUtxos', 'unconfirmedUtxos',
    'noConfirmedUtxoDeferrals', 'unattestedDeferrals', 'bundlesOversize', 'archiveChunkLosses',
    'anchorsAsBackup', 'foldArchiveDroppedOversize', 'foldArchiveNoHeadRoom',
    'confirmationCheckFailures', 'unconfirmedPublishes', 'oldestUnconfirmedPublish',
    'dogeBalance', 'lowBalanceThreshold', 'spendGuard'
];

// Read off spendGuard (a sub-object of getanchorstatus); the per-entry keys under
// oldestUnconfirmedPublish and the last_*_by_chain maps exist only once an event
// has happened, so a fresh producer cannot pin them.
const SPEND_GUARD_KEYS = ['minBalance', 'paused', 'pauseReason'];

const CHECKPOINT_KEYS = [
    'last_finalized_by_chain', 'round_timeouts', 'malformed_finalized', 'sub_quorum_finalized',
    'seq_conflicts', 'seq_double_sign_refusals', 'cosign_declines', 'last_cosign_decline_reason',
    'cadence_stalls', 'cadence_stall_reason', 'cadence_stall_block', 'round_failures_by_chain',
    'last_round_failure_by_chain', 'leader_declines', 'last_leader_decline_by_chain',
    'self_accepts_abandoned'
];
const COSIGN_DECLINE_KEYS = ['indexer_read_failed', 'indexer_no_block'];

const ATTESTATION_KEYS = [
    'failed_count', 'poll_rpc_error_count', 'last_successful_poll_age_ms', 'poll_unsuccessful_for_ms',
    'poll_transport_error_count', 'poll_auth_error_count', 'finalized_evicted_while_pending_count',
    'nonok_evicted_while_pending_count', 'consensus_timeout_count', 'consensus_admission_refused_count'
];

const CROSS_CHAIN_KEYS = ['pending_relay_count', 'result_attempt_failures'];

function missingKeys(obj, keys) {
    return keys.filter(k => !(obj && Object.prototype.hasOwnProperty.call(obj, k)));
}

function pairedDb(extra) {
    return { ...DB_METHODS, async doQuery() { return []; }, ...extra };
}

function anchorPublisher() {
    const identity = new ValidatorIdentity('11'.repeat(32));
    return new StateAnchorPublisher({
        db: pairedDb(), network: 'regtest', capabilitySnapshot: null, capabilityRegistry: null,
        getIdentity: () => identity,
        getPeerManager: () => ({ broadcast() {}, on() {}, removeListener() {} }),
        p2pConfig: {}, resolveBtcLatestBlock: async () => 100
    });
}

function checkpointEngine() {
    const identity = new ValidatorIdentity('11'.repeat(32));
    return new StateCheckpointEngine({
        db: pairedDb({ async findStateCheckpointsByNetwork() { return [{ chain: 'BTC', last_finalized_block: '10', last_seq: '1' }]; } }),
        network: 'regtest',
        p2pConfig: { CHECKPOINT_CHAINS: 'BTC', CHECKPOINT_CONFIRMATIONS: '0', BTC_INDEXER_URL: 'http://stub' },
        hubDbBroadcaster: { broadcastRow() {} },
        getPeerManager: () => ({ on() {}, removeListener() {}, broadcast() {} }),
        getIdentity: () => identity
    });
}

function attestationRound() {
    const hub = createMockHub();
    const round = new AttestationRound({ getPeerManager: () => null, db: null, p2pConfig: {} }, null);
    round.setConsensus(new AttestationConsensus(hub, { get: () => null, list: () => [] }));
    return round;
}

function crossChainEngine() {
    const hub = {
        db: pairedDb({ async findCrossChainCallsByPhase() { return [{ target_chain: 'BTC', pending_relay_count: '2' }]; } }),
        p2pConfig: {}, hubDbBroadcaster: { broadcastRow() {}, broadcastDeletion() {} },
        getPeerManager: () => null, getIdentity: () => null
    };
    return new CrossChainCallEngine(hub);
}

describe('hub stats RPCs: fields xchain-dashboard alerts read', function () {
    this.timeout(30000);
    afterEach(function () { sinon.restore(); });

    it('getanchorstatus emits every key the dashboard reads', async function () {
        const rpc = buildAnchorRpc({ hub: { stateAnchorPublisher: anchorPublisher() } });
        const status = await rpc.getanchorstatus();
        expect(missingKeys(status, ANCHOR_KEYS)).to.deep.equal([]);
        expect(missingKeys(status.spendGuard, SPEND_GUARD_KEYS)).to.deep.equal([]);
    });

    it('getcheckpointstats emits every key the dashboard reads, with its cosign decline sub-keys', async function () {
        const rpc = buildAnchorRpc({ hub: { stateCheckpoints: checkpointEngine() } });
        const stats = await rpc.getcheckpointstats();
        expect(missingKeys(stats, CHECKPOINT_KEYS)).to.deep.equal([]);
        expect(missingKeys(stats.cosign_declines, COSIGN_DECLINE_KEYS)).to.deep.equal([]);
        expect(stats.last_finalized_by_chain.BTC).to.have.property('block_index', 10);
    });

    it('getattestationstats emits every key the dashboard reads', async function () {
        const rpc = buildAttestationRpc({ hub: { attestationRound: attestationRound() } });
        expect(missingKeys(await rpc.getattestationstats(), ATTESTATION_KEYS)).to.deep.equal([]);
    });

    it('getcrosschaincallstats emits every key the dashboard reads', async function () {
        const rpc = buildCrossChainRpc({ hub: { crossChainCalls: crossChainEngine() } });
        const stats = await rpc.getcrosschaincallstats();
        expect(missingKeys(stats, CROSS_CHAIN_KEYS)).to.deep.equal([]);
        expect(stats.pending_relay_count).to.equal(2);
    });

    it('names a key a payload no longer carries', function () {
        const payload = { poll_rpc_error_count: 0 };
        expect(missingKeys(payload, ['poll_rpc_error_count', 'consensus_timeout_count']))
            .to.deep.equal(['consensus_timeout_count']);
    });
});
