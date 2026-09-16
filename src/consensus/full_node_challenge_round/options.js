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
 * XChain Hub - Full-Node Challenge Round: construction
 *
 * What the constructor resolves: the PINNED consensus params, this hub's
 * operational knobs, the verdict publish rail and the empty round state. Plain
 * functions taking the engine, not prototype methods: nothing here is callable
 * behaviour, it is the constructor's body kept inside the readability limit.
 *
 ********************************************************************/

'use strict';

const EncoderClient      = require('../../peers/encoder_client.js');
const SpendGuard         = require('../../lib/spend_guard.js');
// Pinned coin registry: the single source for the consensus-relevant FULLNODE
// parameters. See resolvePinnedParams below.
const coins             = require('../../coins/index.js');
const hubConfig = require('../../config');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Conformance assert: every consensus param must have resolved to a usable
// value FROM THE REGISTRY. A NaN here means the registry lost a key (or this
// hub is pointed at a network whose bundle lacks the block), and running on a
// NaN interval would silently disable challenge rounds rather than fail. Fail
// closed and name the key, so a registry regression surfaces at boot instead of
// as a quorum that mysteriously never forms.
function assertPinnedParams(self){
    for(const [key, value] of Object.entries({
        CHALLENGE_INTERVAL_BLOCKS:    self.interval,
        CONFIRM_DEPTH:                self.confirmDepth,
        VERDICT_ACCEPT_WINDOW_BLOCKS: self.acceptWindow,
        COLLECT_DEPTH_BLOCKS:         self.closeDepth,
    })){
        if(!Number.isFinite(value))
            throw new Error('FullNodeChallengeRound: pinned FULLNODE.' + key + ' is missing or ' +
                'non-numeric in the coin registry for BTC/' + self.network + '. These are consensus ' +
                'inputs and have no env or literal fallback by design; fix the bundled ' +
                'coin registry rather than supplying the value out of band.');
    }
}

// The CONSENSUS-relevant params, read from the pinned coin registry. Returns that
// registry block, which the constructor hands to resolveGenesisVerifiers once the
// operational knobs are assigned, keeping the instance fields in their declared order.
function resolvePinnedParams(self){
    // The CONSENSUS-relevant full-node params come from the PINNED coin
    // registry, never from env or literals.
    //
    // They never resolve as `process.env.FULLNODE_* || cfg.FULLNODE.* || '<literal>'`.
    // That reads the env FIRST on every network, so on MAINNET an operator env var
    // would silently override a pinned consensus parameter, and CONSENSUS_CONFIG_PIN would
    // still verify clean because the pin covers the registry, not what this class
    // actually uses. Two hubs with different FULLNODE_CONFIRM_DEPTH would compute
    // different possession answers and different PASS lists while both reported a
    // matching pin. Literals would be a third, unpinned source of the same values.
    //
    // coins.getCoinConfig() is the single source now. It already applies the
    // regtest-only sidecar and env overrides internally (resolveFullnode), so
    // regtest keeps its tunability through the DESCRIBED surface, while
    // mainnet/testnet get the frozen pinned values with no env surface at all.
    // FULLNODE is BTC-only: the tier is BTC-anchored.
    // Fail closed on an unresolvable network, and say so in terms the operator can
    // act on. getCoinConfig would throw "Unknown network: " here, which names
    // neither the caller nor the fix. A hub that cannot name its network cannot
    // resolve pinned consensus params, and running the round on literals is the
    // exact hazard this refusal exists to close, so it refuses rather than falls back.
    if(self.network !== 'mainnet' && self.network !== 'testnet' && self.network !== 'regtest')
        throw new Error('FullNodeChallengeRound: cannot resolve the pinned FULLNODE params because ' +
            'the hub network is ' + JSON.stringify(self.network) + ' (expected mainnet/testnet/regtest). ' +
            'Set HUB_NETWORK, or leave the full-node challenge round disabled; it must not run on ' +
            'unpinned defaults.');

    const registry = coins.getCoinConfig('BTC', self.network).FULLNODE || {};
    self.registryFullnode = registry;
    self.interval      = parseInt(registry.CHALLENGE_INTERVAL_BLOCKS, 10);
    self.confirmDepth  = parseInt(registry.CONFIRM_DEPTH, 10);
    self.acceptWindow  = parseInt(registry.VERDICT_ACCEPT_WINDOW_BLOCKS, 10);
    // Collection closes when the tip reaches epoch + closeDepth blocks, anchored
    // to chain height (shared by all hubs), NOT each hub's local detection time,
    // so the leader has every claimant's answer before it proposes the PASS list.
    // Pinned in the registry for that reason (see BTC.js COLLECT_DEPTH_BLOCKS).
    self.closeDepth    = parseInt(registry.COLLECT_DEPTH_BLOCKS, 10);

    assertPinnedParams(self);
    return registry;
}

// This hub's own timing and participation knobs, which keep their env surface.
function resolveOperationalKnobs(self, cfg){
    let fn = cfg.FULLNODE || {};
    // OPERATIONAL knobs only below this line: they affect this hub's local timing
    // and participation, not what any hub computes, so they keep their env surface.
    self.enabled       = String(hubConfig.FULLNODE_ENABLED || fn.ENABLED || 'true') !== 'false';
    self.pollMs        = parseInt(hubConfig.FULLNODE_POLL_MS    || fn.POLL_MS    || '30000');
    self.collectMs     = parseInt(hubConfig.FULLNODE_COLLECT_MS || fn.COLLECT_MS || '20000');
}

// The genesis verifier set, from the same pinned registry block as the params.
function resolveGenesisVerifiers(self, registry){
    // Genesis verifiers seed the eligible-verifier universe before any node is
    // verified on-chain, so a key dropped here shrinks the quorum denominator: it is
    // a consensus input and comes from the pinned registry with the rest.
    // Malformed entries are dropped (the indexer's admission rule does the same,
    // so keeping them would only fork this hub's view), but say so, or a
    // typo'd activation looks identical to a correct one.
    let rawGenesis     = Array.isArray(registry.GENESIS_VERIFIERS) ? registry.GENESIS_VERIFIERS : [];
    self.genesis       = new Set(rawGenesis
                            .filter(p => /^[0-9a-fA-F]{64}$/.test(String(p)))
                            .map(p => String(p).toLowerCase()));
    if(self.genesis.size !== rawGenesis.length)
        logger.warn('FullNodeChallengeRound: ignored ' + (rawGenesis.length - self.genesis.size) +
            ' of ' + rawGenesis.length + ' GENESIS_VERIFIERS entries (not a 64-hex Ed25519 pubkey, ' +
            'or a duplicate); using ' + self.genesis.size + '. The verifier quorum is computed over ' +
            'the surviving set.');
}

// The indexer, coin-RPC and verdict-publish rail, and the spend guard and audit
// path that gate the fee it spends.
function initVerdictRail(self, cfg){
    // BTC indexer JSON-RPC (ledger-hash seed + tip); same env surface as
    // StateCheckpointEngine / CrossChainDexEngine.
    self.indexerUrl = hubConfig.BTC_INDEXER_URL     || cfg.BTC_INDEXER_URL     || '';
    self.indexerKey = hubConfig.BTC_INDEXER_API_KEY || cfg.BTC_INDEXER_API_KEY || '';

    // BTC coin full-node RPC (compute the possession answer). Reuses the
    // cross_chain capability's per-chain RPC config; a light validator simply
    // has none, so it can't participate (exactly the property we want).
    let cc = (cfg.cross_chain && cfg.cross_chain.chains && cfg.cross_chain.chains.BTC) || {};
    self.coinRpcUrl = hubConfig.FULLNODE_BTC_RPC || (cfg.FULLNODE && cfg.FULLNODE.BTC_RPC) || cc.rpc || '';

    // On-chain verdict broadcast: operator hook (preferred) or BTC encoder
    // pipeline, mirroring AttestationPublisher / OraclePublisher.
    let encUrl  = hubConfig.BTC_ENCODER_URL || cfg.BTC_ENCODER_URL || '';
    let encKey  = hubConfig.BTC_ENCODER_API_KEY || cfg.BTC_ENCODER_API_KEY || '';
    self.encoder      = encUrl ? new EncoderClient(encUrl, encKey) : null;
    self.broadcastFn  = null;   // fn(wirePayload) -> Promise<{txid}>
    self.walletSignFn = null;   // fn(psbtHex) -> Promise<txHex>
    self.btcAddress   = hubConfig.BTC_ADDRESS || cfg.BTC_ADDRESS || '';

    // The rail a verdict settles on: built, funded and broadcast on BTC through the
    // encoder and address above. src/lib/signer_loader.js reads this to decide
    // whether the operator's one HUB_SIGNER_MODULE may be wired here; the historical
    // module signs with the DOGE key, and wiring it here spent DOGE fees on payloads
    // BTC then read as an invalid REQUEST_ID.
    self.signingChain = 'BTC';
    // Chain each hook was wired FOR, when the wiring site said (signer-loader does).
    // null means an untagged direct wiring, which is trusted, as it was before the
    // declaration existed.
    self._signHookChain      = null;
    self._broadcastHookChain = null;
    self._chainMismatchWarned = false;

    // Shared SpendGuard for the on-chain NODEPROOF verdict spend. Adds a
    // per-window spend ceiling (count + $2000-clamped USD budget, default-ON) and a
    // per-capability runtime pause so an operator can halt verdict BTC spend at
    // runtime; gated at maybeFinalize before the leader broadcasts. Config reads
    // env first (FULLNODE_* keys), then top-level p2pConfig, matching the sibling
    // publishers (the nested cfg.FULLNODE block stays the source for FullNode's own
    // knobs; the guard's knobs are the FULLNODE_*-prefixed ones).
    self.spendGuard = new SpendGuard('FULLNODE', cfg, 'FullNodeChallengeRound');

    // Durable spend audit for the fee-bearing verdict send. The other
    // three hub effectors all leave a recoverable trace of a fee-bearing INTENT
    // before the money moves (AttestationPublisher's fsync'd queue plus
    // spend.jsonl, AttestationRelay's intent WAL, StateAnchorPublisher's
    // anchor_txid IS NULL row); this path had only a post-success console.log, so
    // a crash mid-flight left nothing but stdout retention to say a fee had been
    // committed. Same JSONL-plus-fsync shape and path idiom as AttestationPublisher.
    self.spendLogPath = hubConfig.FULLNODE_SPEND_LOG_PATH || cfg.FULLNODE_SPEND_LOG_PATH ||
                        './data/fullnode-verdict.spend.jsonl';
}

// The empty round state a fresh engine starts from.
function initRoundState(self){
    self.rounds   = new Map();  // epoch -> round state
    // Epochs whose verdict fee a PRIOR process already committed, recovered from
    // the spend log at start(). The in-memory `rounds` map is empty after a
    // restart, so it cannot answer that question.
    self._committedEpochs = new Set();
    self._timer   = null;
    self._ticking = false;      // in-flight guard, see tick()
    self._truncWarnAt = 0;      // throttle for the truncated-set alarm, see eligibleVerifiers()
    self._handler = (env) => self.handleMessage(env);
}

module.exports = { resolvePinnedParams, resolveOperationalKnobs, resolveGenesisVerifiers, initVerdictRail,
    initRoundState };
