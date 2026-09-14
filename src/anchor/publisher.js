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
 * XChain Hub - State Anchor Publisher (the ANCHOR action pipeline)
 *
 * Publishes the protocol's on-chain commitments on DOGE (and ONLY on DOGE,
 * so BTC/LTC carry zero anchor bytes; spec: protocol/actions/ANCHOR.md):
 *
 *   ANCHOR v0: ONE bundle per network per cycle carrying every chain's latest
 *               quorum-signed state checkpoint as a SECTION (signatures come
 *               straight from state_checkpoints; no new signing round).
 *   ANCHOR v1: a checkpoint + a compressed archive of full cross_chain_matches
 *               rows (incl. their validator_signatures + the cross_chain
 *               capability_snapshots needed to re-verify them). This is what
 *               makes cross-chain match data recoverable from a full chain
 *               parse with no surviving hub DB.
 *   ANCHOR v2: continuation chunks when a v1 archive exceeds the per-action
 *               data budget.
 *
 * The version set RESTARTED at 0 pre-launch (spec anchor-v0-single-wire.md): the
 * whole legacy range is unparseable at/above ANCHOR_ACTIVATION, so no number below
 * carries meaning any more and the three wires above are the complete set. The
 * pre-restart shapes these two came from (the v7 bundle and the v6 archive head)
 * survive only in this file's method names, which are seams the suites drive.
 *
 * The v1 canonical covers the archive structure (batch_seq, count, crc32 of the
 * UNCOMPRESSED JSON, total_chunks), so stored checkpoint signatures cannot
 * authenticate an archive. The publisher therefore runs a fresh signing round
 * (XANC_SIGN_REQ / XANC_SIGN) in which every follower verifies the proposed
 * archive AGAINST ITS OWN cross_chain_matches + capability_snapshots before
 * co-signing (a Byzantine elected publisher cannot collect a quorum for
 * fabricated matches or fabricated snapshots). After on-chain publication the
 * leader broadcasts XANC_FINALIZED so every hub back-fills batch_seq /
 * archived_status (audit metadata; harmless if missed, re-archival is
 * deduplicated by recovery's latest-status-wins).
 *
 * Re-archival rule: a match is pending when batch_seq IS NULL (never archived)
 * OR archived_status <> status (retracted after being archived as finalized).
 *
 * Election (attestation-style hash-ordering, spec §8.2 idiom): each pending
 * BUNDLE elects ONE publisher (oracle_publish validators at the bundle's
 * snapshot_block ordered by SHA256(election key ‖ pubkey)
 * ascending, where the key binds network/snapshot_block). Rank 0
 * publishes; if it hasn't after ANCHOR_ELECTION_TOLERANCE_BLOCKS BTC blocks,
 * rank 1 also qualifies, and so on (the DB row's anchor_txid IS NULL is the
 * shared "still pending" signal, so a late rank-0 and an early rank-1 can both
 * publish). The on-chain state never diverges: both build byte-identical
 * commitments, and the anchor-reward rail does NOT inflate: recordAnchorReward
 * deterministically keeps a single reward per (checkpoint_seq, reward_type)
 * across distinct publisher pubkeys (see below), so the only residual cost of
 * the race is the duplicate DOGE tx fee. One validator publishes the whole
 * bundle in a cycle, FROM ITS OWN DOGE WALLET, and the election rotates that
 * work across the federation cycle by cycle. Each successful publish records an
 * `anchor_bundle` / `anchor_archive` reward on the validator_rewards rail (oracle-round
 * pattern; recordAnchorReward collapses failover-race duplicates to a single
 * deterministic per-(round,type) winner, best-effort push to the BTC indexer
 * for COLLECT). The v1 archive round elects a single leader the same way with a
 * per-election-block key. Signer resolution, balance checks and the DOGE
 * broadcast pipeline mirror OraclePublisher (the DB is
 * the durable queue: pending checkpoints are rows with anchor_txid IS NULL,
 * pending matches per the rule above; crash-safe with no separate WAL file).
 * The degenerate single-validator federation keeps today's behavior: one
 * publisher, serialized spends from one wallet. Supersedes the legacy
 * XDEXANCHOR raw payload (CrossChainDexAnchor, retired 2026-06-11 after
 * ANCHOR verified end-to-end on mainnet).
 *
 ********************************************************************/

const zlib              = require('zlib');
const crypto            = require('crypto');
const axios             = require('axios');
const coins             = require('../coins');
const EncoderClient     = require('../peers/encoder_client.js');
const SpendGuard        = require('../lib/spend_guard.js');
const { bftQuorumOrSingle } = require('../lib/bft_quorum.js');
const { resolveQuorumNetwork } = require('./quorum_network.js');
const { isAmbiguousSendError } = require('../lib/idempotent_broadcast.js');
const { sumUtxosCoins, summarizeUtxoConfirmations } = require('../lib/utxo_balance.js');
const { forwardableUtxos } = require('../lib/encoder_utxo_forward.js');
const { assertSingleTxEncoding } = require('../lib/two_phase_guard.js');
const { abandonBuild }           = require('../lib/encoder_reservation.js');
const { resolveCheckpointIntervalBlocks } = require('./checkpoint_cadence.js');
const ValidatorIdentity = require('../validators/identity.js');
const StateCheckpointEngine = require('./checkpoint_engine.js');
const swq                   = require('../stake_weighted_quorum.js');
const eq                    = require('../equivocation_header.js');
const ckpt                  = require('../checkpoint_commitment_activation.js');
const ccr                   = require('../cross_chain_royalty_activation.js');
const ar                    = require('../anchor_reward_activation.js');
const ark                   = require('./anchor_reward_key.js');
const hubConfig = require('../config');
const nodeUtil = require('node:util');
const { installParts } = require('./install_parts.js');
const { ANCHOR_BUNDLE_MAX_BYTES, DEFAULT_ANCHOR_MARKER_RETENTION_MS,
        MATCH_KEYS, CALL_KEYS, XANC_SIGN_REQ, XANC_SIGN, XANC_FINALIZED, XANC_BUNDLE_DONE,
        XANCPUB_SIGN_REQ, XANCPUB_SIGN, XANCARCHPUB_SIGN_REQ, XANCARCHPUB_SIGN,
        XANCREWARD } = require('./publisher/constants.js');
const { getLogger } = require('../observability');
const logger = getLogger();

class StateAnchorPublisher {

    constructor(hub){
        this.hub         = hub;
        this.db          = hub.db;
        this.identity    = hub.getIdentity ? hub.getIdentity() : null;
        this.peerManager = hub.getPeerManager ? hub.getPeerManager() : null;
        this.capSnapshot = hub.capabilitySnapshot || null;
        this.network     = (hub && hub.network) ? hub.network : '';   // STAKE_WEIGHTED_QUORUM gate

        let cfg = hub.p2pConfig || {};
        // Every field this publisher holds is set below, one method per group of
        // related knobs (publisher/options.js).
        this.initPublishCadence(cfg);
        this.initRetryWindows(cfg);
        this.initFailoverLadder(cfg);
        this.initStartupFlush(cfg);
        this.initConfirmedInputPolicy(cfg);
        this.initSpendGuards(cfg);
        this.initCheckpointCadence(cfg);
        this.initDogePipeline(cfg);
        this.initRoundState();
        this.initCounters();
        this.initObservedArchiveState();
        this.initIndexers(cfg);
        this.initDeferralQueues(cfg);
        this.initMarkerRetention(cfg);
    }

    setBroadcastHook(fn){ this.broadcastFn = fn; }
    setWalletSignHook(fn){ this.walletSignFn = fn; }
    setBalanceHook(fn){ this.getBalanceFn = fn; }

    // The peer 'message' subscription stays in this file rather than in a part.
    // PeerManager.MESSAGE_SUBSCRIBERS names this subscriber StateAnchorPublisher, and
    // the listener-ceiling parity check reads that name off the class exported by
    // the file holding the registration, so the registration lives with the class.
    listenToPeers(){
        if(this.peerManager){
            this._messageHandler = (env) => this._handleMessage(env);
            this.peerManager.on('message', this._messageHandler);
        }
    }

    stopListeningToPeers(){
        if(this._messageHandler && this.peerManager){
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
    }

    // Deterministic publisher ordering (AttestationRound's responsible-set
    // idiom): sort the eligible set by SHA256(key ‖ pubkey) ascending. Every
    // hub computes the identical order from the block-boundary snapshot.
    static hashOrder(key, pubkeys){
        return (pubkeys || []).map(pk => {
            let p = String(pk).toLowerCase();
            return { pubkey: p, hash: crypto.createHash('sha256').update(key, 'utf8').update(p, 'utf8').digest('hex') };
        }).sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0)).map(e => e.pubkey);
    }

    // Fixed-key-order match record (shared with the follower verifier + recovery).
    static serializeMatch(m){
        let out = {};
        for(let k of MATCH_KEYS){
            let v = m[k];
            if(k === 'id' || k === 'a_action_index' || k === 'b_action_index' || k === 'snapshot_block' || k === 'effective_time')
                out[k] = Number(v);
            else if(k === 'finalizing_view')
                out[k] = Number(v) || 0;   // EQUIV VIEW; archived so recovery rebuilds the exact signed bytes
            else if(k === 'a_ownership' || k === 'b_ownership')
                out[k] = Number(v) ? 1 : 0;
            else if(k === 'a_tick' || k === 'b_tick')
                out[k] = (v == null) ? null : String(v);
            else if(k === 'a_payout_legs' || k === 'b_payout_legs'){
                // Omit-when-null: legs only exist at/above the CROSS_CHAIN_ROYALTY flag-day
                // (create-side deny below it), so legs-less archives stay byte-identical to
                // those built by pre-royalty hubs and recovery tolerates both shapes.
                if(v != null) out[k] = String(v);
            }
            else
                out[k] = String(v == null ? '' : v);
        }
        return out;
    }

    // Fixed-key-order XCALL relay record (shared with the follower verifier +
    // recovery). result_status / return_payload_b64 are null on dispatch rows.
    static serializeCall(c){
        let out = {};
        for(let k of CALL_KEYS){
            let v = c[k];
            if(k === 'id' || k === 'snapshot_block' || k === 'source_action_index' || k === 'source_contract_index' ||
               k === 'target_contract_index' || k === 'gas_limit' || k === 'cross_hops' || k === 'effective_time')
                out[k] = Number(v);
            else if(k === 'finalizing_view')
                out[k] = Number(v) || 0;   // EQUIV VIEW; archived so recovery rebuilds the exact signed bytes
            else if(k === 'result_status' || k === 'return_payload_b64')
                out[k] = (v == null) ? null : String(v);
            else
                out[k] = String(v == null ? '' : v);
        }
        return out;
    }

    // Fixed-key-order anchor-publish reward record (shared with the follower
    // verifier + recovery). `source` is the earn-time staking address pinned by
    // the archive builder. Recovery restores rewards into the BTC indexer DB
    // BEFORE the reindex, so it cannot resolve sources itself, and a later
    // re-stake of the pubkey from a different address must not move the credit.
    static serializeReward(r, source){
        return {
            validator_pubkey: String(r.validator_pubkey).toLowerCase(),
            source:           String(source),
            round_number:     Number(r.round_number),
            reward_type:      String(r.reward_type),
            amount:           String(r.amount),
            block_index:      Number(r.block_index)
        };
    }

    // Reward identity shared by the archive body and the FINALIZED reward list. The
    // archived record carries no round_qualifier, so the key stops at the three fields
    // both shapes hold.
    static archiveRewardKey(r){
        return String(r.reward_type) + '|' + String(Number(r.round_number)) + '|' +
               String(r.validator_pubkey).toLowerCase();
    }

    // Per-broadcast confirmed-input check, BEFORE anything is built or signed, and
    // it records the reserve reading it took on the way past.
    // The flush-level gate saw the wallet before this pass started spending;
    // several anchors go out back-to-back from one wallet, and the last
    // confirmed output can be gone by the second one. Typed so the caller can
    // treat it as a deferral rather than a failed publish.
    refuseWhenNoConfirmedInput(utxos, allowUnconfirmed){
        if(!allowUnconfirmed && Array.isArray(utxos)){
            let summary = summarizeUtxoConfirmations(utxos, 1);
            this.lastUtxoReserve = { total: summary.total, confirmed: summary.confirmed,
                                     unconfirmed: summary.unconfirmed, known: summary.known, at: summary.at };
            if(summary.known && summary.total > 0 && summary.confirmed === 0){
                let e = new Error('NO_CONFIRMED_UTXO: every spendable output at ' + this.dogeAddress + ' is unconfirmed');
                e.anchorNoConfirmedUtxo = true;
                throw e;
            }
        }
    }

    async defaultBroadcast(payload, signer, opts){
        signer = signer || this.resolveSigner();
        if(!signer.encoder)      throw new Error('no encoder configured (set DOGE_ENCODER_URL)');
        if(!signer.walletSignFn) throw new Error('no wallet sign hook configured');
        if(!this.dogeAddress)    throw new Error('no DOGE_ADDRESS configured');
        let allowUnconfirmed = this.allowUnconfirmedInputs || !!(opts && opts.allowUnconfirmed);
        let utxos = await signer.encoder.getUtxos(this.dogeAddress);
        if(!utxos || (Array.isArray(utxos) && utxos.length === 0)) throw new Error('no UTXOs available for ' + this.dogeAddress);
        this.refuseWhenNoConfirmedInput(utxos, allowUnconfirmed);
        // utxos forwarded only while inside the encoder's caller-facing
        // MAX_UTXO_COUNT; past it the param is omitted so the encoder selects from
        // its own uncapped fetch of this same address (lib/encoder_utxo_forward.js).
        let psbtResult = await signer.encoder.createTx({
            utxos: forwardableUtxos(utxos, 'StateAnchorPublisher'), pubkey: this.dogeAddress, data: payload, change: this.dogeAddress, encoding: 'P2SH',
            // See allowUnconfirmedInputs in the constructor: each anchor stands on its
            // own fee rate, so the encoder must not fund it from mempool change.
            unconfirmed: allowUnconfirmed
        });
        if(!psbtResult || !psbtResult.psbt) throw new Error('encoder returned no PSBT');
        // A successful create_tx RESERVED the inputs it selected (receipt on
        // psbtResult.reservation, 5-minute encoder TTL), so an abandoned build must hand
        // them back or this address is unavailable to every other publisher until the TTL
        // expires. Scoped strictly to the pre-broadcast section below: past the send,
        // holding the inputs is what stops a second build double-spending a transaction
        // that may already have landed. See lib/encoder_reservation.js.
        let txHex;
        try {
            // Refuse phase 1 of a two-transaction encoding before anything is signed: this
            // pipeline has no reveal, so broadcasting the P2SH funding tx would publish an
            // ANCHOR no indexer can decode and strand the carrier value (lib/two_phase_guard.js).
            assertSingleTxEncoding(psbtResult, 'StateAnchorPublisher');
            txHex = await signer.walletSignFn(psbtResult.psbt);
            if(!txHex || typeof txHex !== 'string') throw new Error('wallet sign hook returned invalid tx hex');
        } catch(e){
            await abandonBuild(signer.encoder, psbtResult, 'StateAnchorPublisher');
            throw e;
        }
        // Everything above is pre-send (building/signing; no money has moved).
        // Only broadcast_tx has a side effect, so only ITS failures get the
        // ambiguity classification broadcastWithRetry keys the no-double-
        // broadcast guard on.
        try {
            return (await signer.encoder.broadcastTx(txHex)) || { txid: null };
        } catch(e){
            if(this.isAmbiguousSendError(e)) e.anchorAmbiguousSend = true;
            throw e;
        }
    }
}

module.exports = Object.assign(StateAnchorPublisher, {
    XANC_SIGN_REQ,
    XANC_SIGN,
    XANC_FINALIZED,
    XANC_BUNDLE_DONE,
    XANCPUB_SIGN_REQ,
    XANCPUB_SIGN,
    XANCARCHPUB_SIGN_REQ,
    XANCARCHPUB_SIGN,
    XANCREWARD,
    MATCH_KEYS
});

// The method groups live in publisher/ by behaviour, and this installs them on the
// prototype. It runs AFTER module.exports is assigned because a part that calls one of
// the statics above requires this file back, and a circular require sees only what
// module.exports already holds.
installParts(StateAnchorPublisher.prototype, [
    require('./publisher/state.js'),
    require('./publisher/lifecycle.js'),
    require('./publisher/bundle.js'),
    require('./publisher/publish_bundle.js'),
    require('./publisher/reward.js'),
    require('./publisher/reward_defer.js'),
    require('./publisher/attest_round.js'),
    require('./publisher/archive/attest.js'),
    require('./publisher/archive/round.js'),
    require('./publisher/archive/build.js'),
    require('./publisher/bundle_done.js'),
    require('./publisher/lookups.js'),
    require('./publisher/archive/sign.js'),
    require('./publisher/archive/verify.js'),
    require('./publisher/archive/publish.js'),
    require('./publisher/archive/finalized.js'),
    require('./publisher/archive/finalized_apply.js'),
    require('./publisher/archive/observed.js'),
    require('./publisher/archive/rows.js'),
    require('./publisher/signers.js'),
    require('./publisher/broadcast.js'),
    require('./publisher/intents.js'),
    require('./publisher/options.js'),
]);
