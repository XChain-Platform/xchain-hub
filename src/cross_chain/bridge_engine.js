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
 * XChain Hub - Cross-Chain Bridge Engine
 *
 * Signs the two record families that carry an asset, and its issuer's policy,
 * from the chain it is native on to every chain that holds a copy:
 *
 *   bridge_transfers  one quorum-signed transfer per confirmed source leg (an
 *                     XBRIDGE v0/v3 lock on the origin chain, or an XBRIDGE
 *                     v1/v4 burn of a copy), which the destination indexer
 *                     applies as an injected v2/v5 settle leg.
 *   policy_snapshots  one quorum-signed snapshot of an origin token's policy
 *                     (allow list, block list, tick sleep), which every
 *                     destination materializes onto its bridged copy.
 *
 * Specs: the base bridge spec section 7 (this engine), section 6 (the
 * record and its canonical); the token bridge spec section 5 (the
 * tick and decimals the canonical carries, and the issuer-raised depth);
 * the token bridge policy spec sections 3 and 5 (the snapshot).
 *
 * Shape: the CrossChainDexEngine / CrossChainCallEngine cycle verbatim (D14).
 * Poll each chain's indexer for confirmed work, run the PBFT round over the
 * EQUIV-wrapped canonical, persist the capability snapshot the row is verified
 * against, write the row, mirror it. Both round families reuse
 * CrossChainDexConsensus through its parameterized message types, each on its
 * own gossip channel and its own id field, so a transfer round and a policy
 * round can never be confused for one another.
 *
 * Trust boundary, stated plainly (base spec section 12): in milestone 1 the
 * destination indexer trusts this record for the mint, because off BTC the same
 * hub supplies the validator roster the record is verified against. The
 * checkpoint cross-check (base spec D2, row 17) is what reduces that to "the
 * cross_chain quorum and the checkpoint quorum both lied", and nothing arms on
 * mainnet before it lands.
 *
 ********************************************************************/

const EventEmitter = require('events');
const axios        = require('axios');

const registry               = require('../consensus/gate_registry');
const eq                     = require('../consensus/equivocation_header.js');
const ah                     = require('../lib/admission_height.js');
const CrossChainDexConsensus = require('./dex_consensus.js');
const coins                  = require('../coins');
const hubConfig = require('../config');
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();
const { installParts } = require('./prototype_parts.js');
const { ALLOWED_CHAINS, DEFAULT_POLL_MS } = require('./bridge/constants.js');
const transferPollPart = require('./bridge/transfer_poll.js');
const policyPollPart   = require('./bridge/policy_poll.js');
const validatePart     = require('./bridge/validate.js');
const persistPart      = require('./bridge/persist.js');
const invariantPart    = require('./bridge/invariant.js');
const plumbingPart     = require('./bridge/plumbing.js');

// Activation gates. The tables are rows of the activation registry (the SHARED block in
// src/consensus/gate_registry.js, a byte twin of the indexer's), read by their literal
// keys; the predicate is the registry's own activeAt over the row (W5: the predicate-only
// twin modules that once carried these three retired), so a second hand-written copy of
// a flag day cannot fork the fleet.
//
// A miss is a build defect, not a network state, and THROWS here at construction naming
// the registry key. A null returned here instead idled the engine with no error, no
// failing round and no wire field naming it, which is fail-closed for the wrong reason.
// Fail-closed stays where it belongs: in the predicate, which answers false below the
// height (and for a null or unknown network), so an engine on a network whose activation
// has not been reached still idles and never signs a row there.
const BRIDGE_GATE_KEYS = {
    bridge: 'xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION',
    token:  'token_bridge_activation.TOKEN_BRIDGE_ACTIVATION',
    policy: 'token_policy_activation.TOKEN_POLICY_INHERITANCE_ACTIVATION'
};

// The predicate shape every bridge part calls through gateActive: (block, network, coin).
// Only the bridge map is keyed '<COIN>:<network>' today; the registry's own resolution
// order (coin-keyed entry first, then the bare network) is the one the retired
// predicates used, and it ignores the coin for a map that has no such key.
function loadActivation(key){
    registry.get(key);
    return (block, network, coin) => registry.activeAt(key, network, coin, block, null);
}

class CrossChainBridgeEngine extends EventEmitter {

    constructor(hub){
        super();
        this.hub         = hub;
        this.db          = hub.db;
        this.peerManager = hub.getPeerManager ? hub.getPeerManager() : null;
        this.identity    = hub.getIdentity ? hub.getIdentity() : null;
        this.broadcaster = hub.hubDbBroadcaster || null;
        this.capSnapshot = hub.capabilitySnapshot || null;

        let cfg = hub.p2pConfig || {};
        this.pollMs  = parseInt(hubConfig.XBRIDGE_POLL_MS || cfg.XBRIDGE_POLL_MS || DEFAULT_POLL_MS);
        this.network = (hub && hub.network) ? hub.network : '';

        // Platform confirmation depth per chain, the canonical XCHAIN_CONFIRMATIONS_<COIN>
        // knob shared with the call engine (D38). resolveConfirmations already clamps an
        // override back UP to the per-coin default on mainnet and testnet, so only regtest
        // keeps a lowered value; the DEX engine's private XDEX_MIN_CONFIRMATIONS is
        // deliberately not copied a third time.
        this.confirmations = coins.resolveConfirmations(cfg, this.network);

        // Regtest-only seams, deliberately the SAME env names the DEX and call engines use
        // so one no-BTC regtest stack configures the anchor and the seeded validator once.
        // NaN/false on every other network, so a stray env var or configs row can never
        // reach a SIGNED snapshot anchor or seed a validator on mainnet or testnet.
        let _isRegtest = (this.network === 'regtest');
        this._snapshotBlockOverride = _isRegtest ? parseInt(hubConfig.XDEX_SNAPSHOT_BLOCK || cfg.XDEX_SNAPSHOT_BLOCK) : NaN;
        this._seedLocalValidator    = _isRegtest && (hubConfig.XDEX_SEED_LOCAL_VALIDATOR === '1' ||
                                       cfg.XDEX_SEED_LOCAL_VALIDATOR === '1' || cfg.XDEX_SEED_LOCAL_VALIDATOR === true);

        // Per-coin indexer JSON-RPC endpoints, the idiom every cross-chain engine uses.
        this.indexers = {};
        for(let coin of ALLOWED_CHAINS){
            this.indexers[coin] = {
                url: hubConfig.env()[coin + '_INDEXER_URL'] || cfg[coin + '_INDEXER_URL'] || '',
                key: hubConfig.env()[coin + '_INDEXER_API_KEY'] || cfg[coin + '_INDEXER_API_KEY'] || ''
            };
        }

        // Activation predicates, resolved once. Replaceable on the instance so a test can
        // drive the armed path without vendoring a flag day into src/.
        this.activation = {
            bridge: loadActivation(BRIDGE_GATE_KEYS.bridge),
            token:  loadActivation(BRIDGE_GATE_KEYS.token),
            policy: loadActivation(BRIDGE_GATE_KEYS.policy)
        };
        this._idleLogged = {};

        this.initTransferState();
        this.createRoundConsensus();

        this._pollTimer = null;
        this._polling   = false;
    }

    createRoundConsensus(){
        // Two PBFT channels over one engine. Distinct message types keep bridge gossip out
        // of the DEX and XCALL rounds, and a distinct idField per channel is what makes a
        // policy row proposed on the transfer channel fail the consensus' own
        // `row[idField] === round id` guard before it ever reaches validateProposedMatch.
        this.transferConsensus = new CrossChainDexConsensus(this, {
            messageTypes: {
                PROPOSE:     'XBRIDGE_TRANSFER_PROPOSE',
                PREPARE:     'XBRIDGE_TRANSFER_PREPARE',
                COMMIT:      'XBRIDGE_TRANSFER_COMMIT',
                VIEW_CHANGE: 'XBRIDGE_TRANSFER_VIEW_CHANGE',
                NEW_VIEW:    'XBRIDGE_TRANSFER_NEW_VIEW',
                FINAL_SYNC:  'XBRIDGE_TRANSFER_FINAL_SYNC'
            },
            controlTags: { vc: 'XBRIDGEVC', nv: 'XBRIDGENV' },
            idField: 'transfer_id'
        });
        this.transferConsensus.on('match:finalized', (ev) => {
            this.writeFinalizedTransfer(ev).catch(err =>
                logger.error(nodeUtil.format('CrossChainBridge: write finalized transfer error:', err && err.message)));
        });
        this.transferConsensus.on('match:abandoned', (ev) => {
            this.releaseSourceLegGuard(String(ev.matchId));
        });

        this.policyConsensus = new CrossChainDexConsensus(this, {
            messageTypes: {
                PROPOSE:     'XPOLICY_SNAPSHOT_PROPOSE',
                PREPARE:     'XPOLICY_SNAPSHOT_PREPARE',
                COMMIT:      'XPOLICY_SNAPSHOT_COMMIT',
                VIEW_CHANGE: 'XPOLICY_SNAPSHOT_VIEW_CHANGE',
                NEW_VIEW:    'XPOLICY_SNAPSHOT_NEW_VIEW',
                FINAL_SYNC:  'XPOLICY_SNAPSHOT_FINAL_SYNC'
            },
            controlTags: { vc: 'XPOLICYVC', nv: 'XPOLICYNV' },
            idField: 'snapshot_id'
        });
        this.policyConsensus.on('match:finalized', (ev) => {
            this.writeFinalizedPolicy(ev).catch(err =>
                logger.error(nodeUtil.format('CrossChainBridge: write finalized policy snapshot error:', err && err.message)));
        });
        this.policyConsensus.on('match:abandoned', (ev) => {
            this._inflight.delete(String(ev.matchId));
        });
    }

    async start(){
        // Fill any indexer URL left empty at construction (a configs-table-provisioned hub
        // carries no *_INDEXER_URL env var), then warn loudly for any chain still missing so
        // this engine cannot silently bridge nothing forever.
        if(this.hub && typeof this.hub.resolveIndexerUrl === 'function'){
            for(const coin of Object.keys(this.indexers || {})){
                if(this.indexers[coin] && this.indexers[coin].url) continue;
                try {
                    const u = await this.hub.resolveIndexerUrl(coin);
                    if(u){ this.indexers[coin] = this.indexers[coin] || {}; this.indexers[coin].url = u; }
                } catch(_){}
            }
        }
        for(const coin of Object.keys(this.indexers || {})){
            if(!this.indexers[coin] || !this.indexers[coin].url)
                logger.warn('CrossChainBridge: no indexer URL for chain ' + coin + ' (set ' + coin +
                             '_INDEXER_API_URL / ' + coin + '_INDEXER_URL, or push it via xchain-node updateconfig); ' +
                             'this chain is skipped every tick until configured');
        }
        await this.transferConsensus.start();
        await this.policyConsensus.start();
        this._pollTimer = setInterval(() => {
            this.poll().catch(err => logger.error(nodeUtil.format('CrossChainBridge: poll error:', err && err.message)));
        }, this.pollMs);
        if(this._pollTimer.unref) this._pollTimer.unref();
        logger.info('CrossChainBridge: engine started (poll ' + this.pollMs + 'ms, confirmations ' +
                    ALLOWED_CHAINS.map(c => c + '=' + this.confirmations[c]).join(' ') + ')');
    }

    async stop(){
        if(this._pollTimer){ clearInterval(this._pollTimer); this._pollTimer = null; }
        await this.transferConsensus.stop();
        await this.policyConsensus.stop();
    }

    // ---------------------------------------------------------------------------
    // Canonicals
    // ---------------------------------------------------------------------------

    // The signable payload, byte-identical to what the indexer's settle pass rebuilds from
    // the mirrored row. One method for both families because CrossChainDexConsensus is
    // duck-typed on the engine; which family a row belongs to is decided by which id it
    // carries, and a row carrying both or neither is refused rather than guessed.
    //
    // `view` is the PBFT view the signature is taken at (the live pending.view from
    // consensus, the persisted finalizing_view from a verifier). It lives only in the EQUIV
    // header and is never a content field: putting it in the signed bytes is what lets a
    // legitimate view change be told apart from equivocation.
    // Stamp the row's ADMISSION MAP over the chains that read it, at this hub's fresh
    // admission tip on each plus the table's block margin. Returns false when the round
    // must NOT open.
    //
    // The federation chain list handed to the every-chain rail is the ADMISSION COLUMN set,
    // which is by construction the chains this schema can carry a height for. A chain added
    // to the federation later adds a column, and rows signed before it existed simply do
    // not name it and bind there by effective_time, which is C38's fail-closed direction.
    //
    // C4: with no fresh tip for a reading chain this hub refuses to open the round rather
    // than guessing a height. Every column is named at every height, so a legacy row
    // carries explicit NULLs rather than an absent key.
    async stampAdmission(table, row, label){
        let map = null;
        if(ah.isAdmissionEra(row.network, row.snapshot_block)){
            let readSet = ah.admissionReadSet(table, row, ah.ADMIT_COLUMN_CHAINS);
            map = this.hub && typeof this.hub.resolveAdmitBlocks === 'function'
                ? await this.hub.resolveAdmitBlocks(table, readSet) : null;
            if(!map){
                logger.error('CrossChainBridge: refusing to open the round for ' + label +
                    ' at snapshot_block ' + row.snapshot_block + '; no fresh admission tip for ' +
                    readSet.join(' / '));
                return false;
            }
        }
        Object.assign(row, ah.admitBlocksToColumns(map));
        return true;
    }

    // The shared consensus follower gate cannot infer which of this engine's two mirror
    // tables a proposal belongs to. Require the same exclusive row discriminator as the
    // canonical builder, then derive the table's measured read set.
    admissionScope(row){
        let r = row || {};
        if(!ah.isAdmissionEra(r.network, r.snapshot_block)) return null;
        let hasTransfer = !!r.transfer_id;
        let hasPolicy   = !!r.snapshot_id;
        if(hasTransfer === hasPolicy)
            throw new Error('CrossChainBridge: a row must carry exactly one of transfer_id / snapshot_id');
        let table = hasTransfer ? 'bridge_transfers' : 'policy_snapshots';
        return {
            table,
            readSet: ah.admissionReadSet(table, r, hasPolicy ? ah.ADMIT_COLUMN_CHAINS : undefined)
        };
    }

    canonicalMatch(r, view){
        let hasTransfer = !!(r && r.transfer_id);
        let hasPolicy   = !!(r && r.snapshot_id);
        if(hasTransfer === hasPolicy)
            throw new Error('CrossChainBridge: a row must carry exactly one of transfer_id / snapshot_id');
        if(hasTransfer){
            let raw = [
                'XBRIDGE', r.transfer_id, String(r.snapshot_block), String(r.tick), String(r.decimals),
                r.src_chain, String(r.src_action_index), r.src_address,
                r.dest_chain, r.dest_address, String(r.amount),
                String(r.effective_time), r.network || ''
            ].join('|');
            // A transfer is read by dest_chain alone, so its map has one entry.
            raw += ah.admissionCanonicalField('CrossChainBridge', r.network, r.snapshot_block, ah.rowAdmitBlocks(r));
            if(eq.isEquivHeaderActive(r.snapshot_block, r.network))
                return eq.buildEquivCanonical(eq.ENGINE_TAGS.BRIDGE, r.transfer_id, (view != null ? view : 0), raw);
            return raw;
        }
        let raw = [
            'XPOLICY', r.snapshot_id, String(r.snapshot_block), r.origin_chain, String(r.tick),
            String(r.policy_seq), String(r.origin_block), String(r.policy_hash),
            String(r.effective_time), r.network || ''
        ].join('|');
        // A policy snapshot is the sharp case: its consuming select carries NO chain clause
        // at all, so its map must name every chain the federation serves. A chain added
        // after the row was signed is simply absent from it and binds there by the legacy
        // effective_time rule, which is safe by construction rather than silently unbound.
        raw += ah.admissionCanonicalField('CrossChainPolicy', r.network, r.snapshot_block, ah.rowAdmitBlocks(r));
        if(eq.isEquivHeaderActive(r.snapshot_block, r.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.POLICY, r.snapshot_id, (view != null ? view : 0), raw);
        return raw;
    }

    async indexerCall(coin, method, params){
        let ix = this.indexers[coin];
        if(!ix || !ix.url) throw new Error('no indexer url for ' + coin);
        let headers = { 'Content-Type': 'application/json' };
        if(ix.key) headers['x-api-key'] = ix.key;
        let resp = await axios.post(ix.url, { jsonrpc: '2.0', method, params: params || {}, id: 1 },
                                    { headers, timeout: 15000 });
        if(resp.data && resp.data.error) throw new Error('indexer RPC error: ' + JSON.stringify(resp.data.error));
        return resp.data ? resp.data.result : null;
    }

}

installParts(CrossChainBridgeEngine.prototype, [
    transferPollPart, policyPollPart, validatePart, persistPart, invariantPart, plumbingPart
]);

// The keys the engine judges, for the guards and tests that prove each one has a row.
CrossChainBridgeEngine.BRIDGE_GATE_KEYS = BRIDGE_GATE_KEYS;

module.exports = CrossChainBridgeEngine;
