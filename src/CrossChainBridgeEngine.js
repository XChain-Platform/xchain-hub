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

const crypto       = require('crypto');
const EventEmitter = require('events');
const axios        = require('axios');

const bc                     = require('./bcmath.js');
const swq                    = require('./stake_weighted_quorum.js');
const eq                     = require('./equivocation_header.js');
const CrossChainDexConsensus = require('./CrossChainDexConsensus.js');
const { normalizeRetractionBounds } = require('./lib/retraction_bounds.js');
const { RELAY_MIN_FUTURE_S, relayMarginFloorS } = require('./lib/relay_margin.js');
const { allCanonicalInts }   = require('./lib/canonical_int.js');
const snapWrite              = require('./lib/capability_snapshot_write.js');
const coins                  = require('./coins');

const ALLOWED_CHAINS  = [...coins.ALLOWED_COINS];
const DEFAULT_POLL_MS = 15000;

// Per-poll page size for the pending-leg read on one chain.
const PENDING_PAGE    = 100;

// The INT-backed fields each canonical signs VERBATIM while the indexer rebuilds them
// from the mirrored BIGINT/TINYINT row. A leader-supplied '041' passes every
// Number()-based re-derivation below yet finalizes a record whose signatures no
// settling indexer can reproduce, so the spellings are gated before any numeric
// comparison. Ticks, addresses, chains and the bcmath decimal `amount` are string
// compares and deliberately absent.
const TRANSFER_CANONICAL_INT_FIELDS = ['snapshot_block', 'src_action_index', 'decimals', 'effective_time'];
const POLICY_CANONICAL_INT_FIELDS   = ['snapshot_block', 'policy_seq', 'origin_block', 'effective_time'];

// Working precision for every amount sum in the invariant read. A token declares up to
// MAX_TOKEN_DECIMALS (18, xchain-indexer config.js), and bcmath's helpers default to
// precision 0, which SILENTLY ROUNDS: bcadd('2.0', '1.5') is 4 without this. The sums are
// display and alarm arithmetic, never a hash input, but an alarm that rounds is an alarm
// that invents a deficit, so they run at the widest precision the platform allows.
const AMOUNT_SCALE = 18;

// Ceiling on the membership of one inherited list (policy spec R2, RULED a 2026-09-11).
// Canonical value: xchain-documentation/protocol/constants.js XPOLICY_MAX_MEMBERS, which
// the indexer enforces at ISSUE format 7; the hub enforces it here as the second half of
// the same rule (section 8: "the hub declines to sign a snapshot whose membership exceeds
// it, one log line, the previous snapshot stays in force"). Nothing depends on the number
// in a hash, so a later flag day can raise it. Named locally for the same reason
// constants.js XCALL_MAX_HOPS is: the hub cannot require across package boundaries.
const XPOLICY_MAX_MEMBERS = 10000;

// How far a follower's own BTC tip view may sit from a leader's snapshot_block before it
// refuses to co-sign: about a day of BTC blocks, the bound every sibling engine uses.
// Pinning an ancient snapshot_block would let a Byzantine leader select a stale validator
// set for the indexer-side signature check.
const SNAPSHOT_BLOCK_TOLERANCE = 144;

// Activation gates. The canonical maps are xchain-indexer/src/xchain_bridge_activation.js,
// token_bridge_activation.js and token_policy_activation.js, mirrored into
// xchain-documentation/protocol/constants.js and held equal by the indexer's
// activationConstantsParity test. The hub reads a VENDORED twin beside its other
// *_activation.js copies, exactly as it does for checkpoint_commitment and the attest
// gates, because a second hand-written copy of a flag day is a fork waiting to happen.
//
// A twin that is missing or unreadable is not an error here: every load below returns null
// and the engine FAILS CLOSED, idling instead of polling a chain whose flag day it cannot
// read. That is the correct posture in both directions, because an engine that polled
// without a gate would sign rows on a network where the activation has not been reached.
function loadActivation(moduleName, predicate){
    try {
        // eslint-disable-next-line global-require
        let mod = require('./' + moduleName + '.js');
        let fn  = mod && mod[predicate];
        return (typeof fn === 'function') ? fn : null;
    } catch(e){
        return null;
    }
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
        this.pollMs  = parseInt(process.env.XBRIDGE_POLL_MS || cfg.XBRIDGE_POLL_MS || DEFAULT_POLL_MS);
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
        this._snapshotBlockOverride = _isRegtest ? parseInt(process.env.XDEX_SNAPSHOT_BLOCK || cfg.XDEX_SNAPSHOT_BLOCK) : NaN;
        this._seedLocalValidator    = _isRegtest && (process.env.XDEX_SEED_LOCAL_VALIDATOR === '1' ||
                                       cfg.XDEX_SEED_LOCAL_VALIDATOR === '1' || cfg.XDEX_SEED_LOCAL_VALIDATOR === true);

        // Per-coin indexer JSON-RPC endpoints, the idiom every cross-chain engine uses.
        this.indexers = {};
        for(let coin of ALLOWED_CHAINS){
            this.indexers[coin] = {
                url: process.env[coin + '_INDEXER_URL'] || cfg[coin + '_INDEXER_URL'] || '',
                key: process.env[coin + '_INDEXER_API_KEY'] || cfg[coin + '_INDEXER_API_KEY'] || ''
            };
        }

        // Activation predicates, resolved once. Replaceable on the instance so a test can
        // drive the armed path without vendoring a flag day into src/.
        this.activation = {
            bridge: loadActivation('xchain_bridge_activation', 'isXchainBridgeActive'),
            token:  loadActivation('token_bridge_activation',  'isTokenBridgeActive'),
            policy: loadActivation('token_policy_activation',  'isTokenPolicyInheritanceActive')
        };
        this._idleLogged = {};

        // Round ids in PBFT but not yet written (the sibling engines' _inflight).
        this._inflight = new Set();

        // Live pending legs from the LAST completed poll, keyed `<tick>|<dest_chain>`, as
        // an array of decimal amount strings. A lock that is mined but not yet at depth has
        // already debited its sender and credited the escrow on the origin chain, while the
        // destination has not minted: without counting it the invariant would read a false
        // SURPLUS for the whole confirmation window. See getBridgeInvariant.
        this._pendingInFlight = new Map();

        // Resolved origin chain per `<network>|<tick>`. A tick's origin is the chain its
        // native row lives on; bridge_transfers carries the chains but never the direction
        // (D19), so it is learned from the pending read's transfer_kind (a lock's src_chain
        // is the origin) and cached for the policy poll after a restart.
        this._tickOrigin = new Map();

        // Escrow and supply come from chain state, which no hub table holds. Null means "use
        // the default reader", _readBridgeBalances over each chain's own indexer; an assigned
        // function replaces it wholesale, which is how a test or an operator tool drives the
        // read without an indexer. See getBridgeInvariant for the contract.
        this.chainStateReader = null;

        // One degraded-read line per chain per process, not one per poll.
        this._chainStateLogged = {};

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
            this._writeFinalizedTransfer(ev).catch(err =>
                console.error('CrossChainBridge: write finalized transfer error:', err && err.message));
        });
        this.transferConsensus.on('match:abandoned', (ev) => {
            this._inflight.delete(String(ev.matchId));
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
            this._writeFinalizedPolicy(ev).catch(err =>
                console.error('CrossChainBridge: write finalized policy snapshot error:', err && err.message));
        });
        this.policyConsensus.on('match:abandoned', (ev) => {
            this._inflight.delete(String(ev.matchId));
        });

        this._pollTimer = null;
        this._polling   = false;
    }

    async start(){
        // Fill any indexer URL left empty at construction (a configs-table-provisioned hub
        // carries no *_INDEXER_URL env var), then warn loudly for any chain still missing so
        // this engine cannot silently bridge nothing forever.
        if(this.hub && typeof this.hub._resolveIndexerUrl === 'function'){
            for(const coin of Object.keys(this.indexers || {})){
                if(this.indexers[coin] && this.indexers[coin].url) continue;
                try {
                    const u = await this.hub._resolveIndexerUrl(coin);
                    if(u){ this.indexers[coin] = this.indexers[coin] || {}; this.indexers[coin].url = u; }
                } catch(_){}
            }
        }
        for(const coin of Object.keys(this.indexers || {})){
            if(!this.indexers[coin] || !this.indexers[coin].url)
                console.warn('CrossChainBridge: no indexer URL for chain ' + coin + ' (set ' + coin +
                             '_INDEXER_API_URL / ' + coin + '_INDEXER_URL, or push it via xchain-node updateconfig); ' +
                             'this chain is skipped every tick until configured');
        }
        await this.transferConsensus.start();
        await this.policyConsensus.start();
        this._pollTimer = setInterval(() => {
            this._poll().catch(err => console.error('CrossChainBridge: poll error:', err && err.message));
        }, this.pollMs);
        if(this._pollTimer.unref) this._pollTimer.unref();
        console.log('CrossChainBridge: engine started (poll ' + this.pollMs + 'ms, confirmations ' +
                    ALLOWED_CHAINS.map(c => c + '=' + this.confirmations[c]).join(' ') + ')');
    }

    async stop(){
        if(this._pollTimer){ clearInterval(this._pollTimer); this._pollTimer = null; }
        await this.transferConsensus.stop();
        await this.policyConsensus.stop();
    }

    // ---------------------------------------------------------------------------
    // Activation
    // ---------------------------------------------------------------------------

    // Is a gate armed for `block` on this hub's network? Fails CLOSED on a missing
    // predicate (an unvendored flag-day twin) and logs the reason once per gate, so an
    // operator sees why the engine is idle instead of watching it quietly sign nothing.
    _gateActive(name, block){
        let fn = this.activation && this.activation[name];
        if(typeof fn !== 'function'){
            if(!this._idleLogged[name]){
                this._idleLogged[name] = true;
                console.warn('CrossChainBridge: the ' + name + ' activation module is not readable in this hub; ' +
                             'the engine stays idle for that family (fail closed) until the flag-day twin is vendored');
            }
            return false;
        }
        try { return !!fn(block, this.network); }
        catch(e){ return false; }
    }

    // ---------------------------------------------------------------------------
    // Poll
    // ---------------------------------------------------------------------------

    async _poll(){
        if(this._polling) return;               // never overlap a slow poll
        this._polling = true;
        try {
            let snapshotBlock = await this._resolveSnapshotBlock();
            if(snapshotBlock == null) return;   // no anchor: sign nothing this tick
            // A hub on a pre-activation network never polls (base spec section 7). The gate
            // is keyed on the BTC-anchored snapshot block, the same anchor that selects the
            // validator set, so every hub in the federation flips on one height.
            if(!this._gateActive('bridge', snapshotBlock)) return;
            let pending = new Map();
            for(let coin of ALLOWED_CHAINS){
                if(!this.indexers[coin] || !this.indexers[coin].url) continue;
                try { await this._pollPendingTransfers(coin, snapshotBlock, pending); }
                catch(e){ console.warn('CrossChainBridge: pending poll failed on ' + coin + ': ' + (e && e.message)); }
            }
            // Swap the in-flight view in only after a full sweep, so a chain that failed
            // mid-pass cannot drop its legs out of the invariant and turn a healthy read
            // into a phantom surplus.
            this._pendingInFlight = pending;
            if(this._gateActive('policy', snapshotBlock)){
                try { await this._pollPolicySnapshots(snapshotBlock); }
                catch(e){ console.warn('CrossChainBridge: policy poll failed: ' + (e && e.message)); }
            }
        } finally {
            this._polling = false;
        }
    }

    // Discover confirmed source legs on `coin` and run a transfer round for each.
    async _pollPendingTransfers(coin, snapshotBlock, pendingOut){
        let res;
        try { res = await this._indexerCall(coin, 'getpendingbridgetransfers', { limit: PENDING_PAGE }); }
        catch(e){ return; }
        if(!res || !Array.isArray(res.transfers) || !res.network) return;
        let latest = Number(res.latest_block_index);
        if(!Number.isFinite(latest)) return;
        for(let t of res.transfers){
            // Every pending leg is in flight from the moment its source is mined, whether or
            // not it has reached depth: the origin escrow already holds the value and the
            // destination has not minted it.
            this._recordPending(pendingOut, t);
            try { await this._maybeFinalizeTransfer(coin, String(res.network), latest, snapshotBlock, t); }
            catch(e){ console.warn('CrossChainBridge: transfer round failed for ' + coin + ':' +
                                   String(t && t.src_action_index) + ': ' + (e && e.message)); }
        }
    }

    _recordPending(pendingOut, t){
        if(!t || !t.tick || !t.dest_chain) return;
        let key = String(t.tick) + '|' + String(t.dest_chain);
        let arr = pendingOut.get(key) || [];
        arr.push(String(t.amount));
        pendingOut.set(key, arr);
    }

    // The depth this federation waits for before it signs a leg on `coin`: the platform
    // default raised, never lowered, by the origin row's MIN_DEPTH as the lock STAMPED it
    // at its own block (token spec section 7, D24). Stamped rather than re-read at poll
    // time, so a later edit of the origin row can never make an accepted lock un-signable
    // and two followers can never disagree. Nothing is signed for it.
    _effectiveDepth(coin, minDepth){
        let platform = Number(this.confirmations[coin]);
        if(!Number.isFinite(platform) || platform <= 0) platform = 1;
        let raised = Number(minDepth);
        if(!Number.isFinite(raised) || raised <= 0) return platform;
        return Math.max(platform, raised);
    }

    async _maybeFinalizeTransfer(coin, network, latestBlock, snapshotBlock, t){
        if(!t) return;
        let kind = String(t.transfer_kind || '');
        if(kind !== 'lock' && kind !== 'burn') return;
        let destChain = String(t.dest_chain || '');
        if(!ALLOWED_CHAINS.includes(destChain) || destChain === coin) return;
        let tick = String(t.tick || '');
        if(!tick) return;
        // A general-token leg needs the token-bridge gate as well as the bridge gate; the
        // base spec's own legs are XCHAIN and ride the bridge gate alone. The parity test
        // pins TOKEN_BRIDGE_ACTIVATION >= XCHAIN_BRIDGE_ACTIVATION per network, so this can
        // never arm v3/v4 without an engine behind it.
        if(tick !== 'XCHAIN' && !this._gateActive('token', snapshotBlock)) return;

        let srcActionIndex = Number(t.src_action_index);
        if(!Number.isInteger(srcActionIndex) || srcActionIndex <= 0) return;

        // Confirmation gate: the only defence against signing a reorg-able source leg. An
        // applied mint is final on a destination that did not reorg (D16), so the depth is
        // the attacker's price for that loss.
        let depth = latestBlock - Number(t.block_index) + 1;
        if(!Number.isFinite(depth) || depth < this._effectiveDepth(coin, t.min_depth)) return;

        // The origin chain of this tick, learned from the leg's own kind: a lock is mined on
        // the chain the token is native to, a burn on a chain that holds a copy.
        this._tickOrigin.set(network + '|' + tick, kind === 'lock' ? coin : destChain);

        let transferId = this._deriveTransferId(network, coin, srcActionIndex, destChain,
                                                String(t.dest_address || ''), snapshotBlock);
        if(this._inflight.has(transferId)) return;
        if(await this.db.bridgeTransferExistsForSource(network, coin, srcActionIndex)) return;

        let row = {
            transfer_id:          transferId,
            snapshot_block:       Number(snapshotBlock),
            network:              network,
            src_chain:            coin,
            src_action_index:     srcActionIndex,
            src_address:          String(t.src_address || ''),
            dest_chain:           destChain,
            dest_address:         String(t.dest_address || ''),
            tick:                 tick,
            decimals:             Number(t.decimals),
            amount:               String(t.amount),
            // Forward propagation margin, sized to the chain that GATES the row: every
            // indexer applies it at the first block whose protocol block_time reaches the
            // stamp, so a bare clock second would make it eligible the instant it finalized
            // and two indexers would inject it at different action indexes.
            effective_time:       this._nowSeconds() + relayMarginFloorS(destChain),
            // Source-chain reorg fence, stamped from the source indexer's own generation.
            // Metadata, NOT part of the signed canonical: an unfenced quorum-class
            // retraction is refused outright, so a follower pins this to its own view below.
            push_generation:      Number(t.push_generation) || 0
        };
        if(!Number.isInteger(row.decimals) || row.decimals < 0 || row.decimals > 18) return;
        if(!row.src_address || !row.dest_address) return;
        if(bc.bclte(this._normalizeAmount(row.amount) || '0', 0)) return;

        let validators = await this._resolveCapabilityValidators('cross_chain', Number(snapshotBlock), network);
        this._inflight.add(transferId);
        try {
            await this.transferConsensus.propose(transferId, {
                row: row, snapshot: { validators: validators, count: validators.length }
            });
        } catch(e){
            this._inflight.delete(transferId);
            throw e;
        }
    }

    // ---------------------------------------------------------------------------
    // Policy snapshots (policy spec section 3 step 2)
    // ---------------------------------------------------------------------------

    // Every (origin_chain, tick) pair this hub should hold a current policy for: the pairs
    // its own finalized transfers name, plus any tick seen with a pending leg this cycle,
    // so a token's FIRST snapshot is signed in the same cycle its first lock is seen.
    async _policyPairs(network){
        let pairs = new Map();
        let add = (origin, tick, copyChain) => {
            if(!origin || !tick) return;
            let key = origin + '|' + tick;
            let e = pairs.get(key) || { origin_chain: origin, tick: tick, copies: new Set() };
            if(copyChain && copyChain !== origin) e.copies.add(copyChain);
            pairs.set(key, e);
        };
        let rows = [];
        try { rows = await this.db.getBridgeTransferChainPairs(network); }
        catch(e){ rows = []; }
        for(let r of (rows || [])){
            let tick   = String(r.tick);
            let origin = this._tickOrigin.get(network + '|' + tick);
            // Without a learned origin the direction of the pair is unknowable from the row
            // alone (direction is derived, never stored, D19), so the pair waits for the poll
            // that carries its transfer_kind rather than guessing a side and signing a
            // snapshot read off the wrong chain.
            if(!origin) continue;
            let other = (String(r.src_chain) === origin) ? String(r.dest_chain) : String(r.src_chain);
            add(origin, tick, other);
        }
        for(let [key, amounts] of this._pendingInFlight){
            if(!amounts || !amounts.length) continue;
            let sep  = key.lastIndexOf('|');
            let tick = key.slice(0, sep);
            let dest = key.slice(sep + 1);
            let origin = this._tickOrigin.get(network + '|' + tick);
            if(!origin) continue;
            add(origin, tick, dest);
        }
        return [...pairs.values()];
    }

    async _pollPolicySnapshots(snapshotBlock){
        let network = this.network;
        for(let pair of await this._policyPairs(network)){
            try { await this._maybeSnapshotPolicy(pair, network, snapshotBlock); }
            catch(e){ console.warn('CrossChainBridge: policy round failed for ' + pair.origin_chain + ':' +
                                   pair.tick + ': ' + (e && e.message)); }
        }
    }

    // The confirmed origin height every follower can re-read identically: the origin tip
    // minus that chain's platform confirmation depth. Returns null when the tip is
    // unreadable, which ABSTAINS this cycle rather than reading at an unconfirmed height.
    async _policyOriginBlock(originChain){
        let res;
        try { res = await this._indexerCall(originChain, 'getlatestblock', {}); }
        catch(e){ return null; }
        let latest = Number(res && (res.block_index != null ? res.block_index : res.latest_block_index));
        if(!Number.isFinite(latest)) return null;
        let at = latest - Number(this.confirmations[originChain] || 1);
        return at > 0 ? at : null;
    }

    async _maybeSnapshotPolicy(pair, network, snapshotBlock){
        let originChain = pair.origin_chain;
        if(!this.indexers[originChain] || !this.indexers[originChain].url) return;
        let originBlock = await this._policyOriginBlock(originChain);
        if(originBlock == null) return;

        let policy;
        try { policy = await this._indexerCall(originChain, 'gettokenpolicy', { tick: pair.tick, origin_block: originBlock }); }
        catch(e){ return; }                       // read failure abstains; never refuses (D16)
        if(!policy || policy.error) return;       // the tick has no native row here

        let shaped = this._shapePolicy(policy);
        if(!shaped) return;
        // The membership ceiling (R2). Declining is the whole action: the previous snapshot
        // stays in force and the watch raises WARN, so an oversized list can never be
        // materialized onto a copy but also never wedges the tick's existing policy.
        if(shaped.oversized){
            console.warn('CrossChainBridge: declining to sign a policy snapshot for ' + originChain + ':' +
                         pair.tick + ' (a list exceeds XPOLICY_MAX_MEMBERS=' + XPOLICY_MAX_MEMBERS +
                         '); the previous snapshot stays in force');
            return;
        }
        // Membership arrays are TRANSPORT and are verified against the hash on apply, so a
        // snapshot whose own indexer answer does not hash to its own policy_hash would be
        // refused by every destination. Recompute rather than trust the read.
        let hash = this._policyHash(shaped.allow, shaped.block, shaped.sleeping);
        if(String(policy.policy_hash || '').toLowerCase() !== hash){
            console.warn('CrossChainBridge: gettokenpolicy for ' + originChain + ':' + pair.tick +
                         ' returned a policy_hash that does not match its own membership; not signing');
            return;
        }

        let lastSeq = await this.db.getLatestPolicySeq(network, originChain, pair.tick);
        if(lastSeq > 0){
            let held = await this.db.getPolicySnapshotAtSeq(network, originChain, pair.tick, lastSeq);
            // Unchanged policy: nothing to sign. This is the common case every cycle.
            if(held && String(held.policy_hash).toLowerCase() === hash) return;
        }
        let policySeq = lastSeq + 1;
        let snapshotId = this._deriveSnapshotId(network, originChain, pair.tick, policySeq, snapshotBlock);
        if(this._inflight.has(snapshotId)) return;

        let row = {
            snapshot_id:     snapshotId,
            snapshot_block:  Number(snapshotBlock),
            origin_chain:    originChain,
            tick:            pair.tick,
            policy_seq:      policySeq,
            origin_block:    Number(originBlock),
            policy_hash:     hash,
            allow_list:      shaped.allow === null ? null : JSON.stringify(shaped.allow),
            block_list:      shaped.block === null ? null : JSON.stringify(shaped.block),
            sleeping:        shaped.sleeping ? 1 : 0,
            // Sized to the SLOWEST chain that holds a copy per this hub's own transfer rows,
            // never over the issuer's BRIDGE_CHAINS (which an issuer can empty while copies
            // are still outstanding). NOT monotonic across policy_seq, which is why apply
            // order is by seq and never by time.
            effective_time:  this._nowSeconds() + this._policyMarginS(pair.copies, originChain),
            network:         network,
            push_generation: 0
        };

        let validators = await this._resolveCapabilityValidators('cross_chain', Number(snapshotBlock), network);
        this._inflight.add(snapshotId);
        try {
            await this.policyConsensus.propose(snapshotId, {
                row: row, snapshot: { validators: validators, count: validators.length }
            });
        } catch(e){
            this._inflight.delete(snapshotId);
            throw e;
        }
    }

    // The propagation window an effective_time carries: `max(relayMarginFloorS(c))` over
    // every chain c that holds a COPY of this tick (policy spec section 5, and the
    // effective_time column comment in src/sql/policy_snapshots.sql). The copies are the
    // only indexers that ever APPLY the snapshot, so they are the only ones the deadline
    // has to reach; a BTC copy pins it at 2400 s, copies {DOGE} at 240 s, {DOGE,LTC} at the
    // larger of those two. Seeding the maximum with BTC's floor unconditionally would stamp
    // 2400 s on a snapshot whose copies are all fast chains, which is not what the spec
    // says and which delays every policy change on a DOGE-only token by forty minutes.
    //
    // With NO copies (a burn back to the origin is the only leg this hub has seen) there is
    // no destination to reach, but the row still needs a window in the future to be
    // co-signed at all, so it falls back to the origin chain's own floor: the origin
    // indexer is the only one that holds the tick.
    _policyMarginS(copies, originChain){
        let list = [...(copies || [])];
        if(!list.length) return relayMarginFloorS(originChain);
        let margin = 0;
        for(let c of list) margin = Math.max(margin, relayMarginFloorS(c));
        return margin;
    }

    // Normalize a gettokenpolicy answer into the three signed inputs, or null when the
    // answer is not usable. A list is either null (the origin row has no such list) or an
    // array of members; the arrays must already be in canonical order, which the apply side
    // also verifies and never re-sorts (D13), so an out-of-order answer is refused here too
    // rather than silently re-sorted into a hash the origin never held.
    _shapePolicy(policy){
        let one = (v) => {
            if(v === null || v === undefined) return null;
            if(!Array.isArray(v)) return undefined;
            return v.map(x => String(x));
        };
        let allow = one(policy.allow_list);
        let block = one(policy.block_list);
        if(allow === undefined || block === undefined) return null;
        if(!this._isCanonicalOrder(allow) || !this._isCanonicalOrder(block)) return null;
        let oversized = (allow && allow.length > XPOLICY_MAX_MEMBERS) ||
                        (block && block.length > XPOLICY_MAX_MEMBERS);
        return { allow: allow, block: block, sleeping: !!policy.sleeping, oversized: !!oversized };
    }

    // Byte order (utf8_bin), strictly ascending: the order getList returns for a type-2
    // list. Buffer.compare is the byte comparison; String < would use UTF-16 code units,
    // which differ from byte order above the BMP.
    _isCanonicalOrder(list){
        if(list === null) return true;
        for(let i = 1; i < list.length; i++){
            if(Buffer.compare(Buffer.from(list[i - 1], 'utf8'), Buffer.from(list[i], 'utf8')) >= 0) return false;
        }
        return true;
    }

    // sha256 over the canonical membership text (policy spec section 5):
    //   ALLOW|<n or ->|<addr>|... |BLOCK|<m or ->|<addr>|... |SLEEP|<0 or 1>
    // `-` means the origin row has no such list, `0` means it has an EMPTY one. The two are
    // not the same thing: isActionAllowed denies everyone on an empty allow list, so a copy
    // must be able to tell "no policy" from "allow nobody".
    _policyHash(allow, block, sleeping){
        let part = (label, list) => {
            if(list === null) return [label, '-'];
            return [label, String(list.length)].concat(list.map(a => String(a)));
        };
        let text = part('ALLOW', allow)
            .concat(part('BLOCK', block))
            .concat(['SLEEP', sleeping ? '1' : '0'])
            .join('|');
        return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
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
    _canonicalMatch(r, view){
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
            if(eq.isEquivHeaderActive(r.snapshot_block, r.network))
                return eq.buildEquivCanonical(eq.ENGINE_TAGS.BRIDGE, r.transfer_id, (view != null ? view : 0), raw);
            return raw;
        }
        let raw = [
            'XPOLICY', r.snapshot_id, String(r.snapshot_block), r.origin_chain, String(r.tick),
            String(r.policy_seq), String(r.origin_block), String(r.policy_hash),
            String(r.effective_time), r.network || ''
        ].join('|');
        if(eq.isEquivHeaderActive(r.snapshot_block, r.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.POLICY, r.snapshot_id, (view != null ? view : 0), raw);
        return raw;
    }

    // sha256(network | src_chain:src_action_index | dest_chain:dest_address | snapshot_block),
    // the _deriveMatchId shape with snapshot_block INSIDE the preimage on purpose: the DEX
    // had to patch a stranding bug where a retracted row kept the id a re-formed match
    // needed, and the revive in db.insertBridgeTransfer is the other half of that fix.
    _deriveTransferId(network, srcChain, srcActionIndex, destChain, destAddress, snapshotBlock){
        let s = String(network || '') +
                '|' + String(srcChain) + ':' + String(srcActionIndex) +
                '|' + String(destChain) + ':' + String(destAddress) +
                '|' + String(snapshotBlock);
        return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
    }

    // sha256(network | origin_chain:tick | policy_seq | snapshot_block).
    _deriveSnapshotId(network, originChain, tick, policySeq, snapshotBlock){
        let s = String(network || '') +
                '|' + String(originChain) + ':' + String(tick) +
                '|' + String(policySeq) +
                '|' + String(snapshotBlock);
        return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
    }

    // ---------------------------------------------------------------------------
    // Follower verification
    // ---------------------------------------------------------------------------

    // What a peer runs before it signs a leader's proposed row. A Byzantine leader cannot
    // get us to sign a record we cannot independently see: the transfer is re-fetched from
    // OUR source-chain indexer field for field at OUR effective depth, and the policy is
    // re-read from OUR origin-chain indexer at the SAME origin_block and must hash the same.
    async validateProposedMatch(row){
        if(!row) return false;
        let hasTransfer = !!row.transfer_id;
        let hasPolicy   = !!row.snapshot_id;
        if(hasTransfer === hasPolicy) return false;

        // Leader-choice fields are ADOPTED, not re-derived, so bound them. effective_time
        // must sit in a window ahead of our own clock: the upper guard stops a far-future
        // stamp whose row never applies (a griefing hold on the escrow), the lower guard is
        // the propagation floor, because a row effective at or behind our clock is eligible
        // the instant it finalizes and two indexers then inject it at different blocks.
        let now = this._nowSeconds();
        if(!Number.isFinite(Number(row.effective_time)) ||
           Number(row.effective_time) - now > 3600 ||
           Number(row.effective_time) - now < RELAY_MIN_FUTURE_S) return false;
        let myBlock = await this._resolveSnapshotBlock();
        if(myBlock != null && Math.abs(Number(row.snapshot_block) - Number(myBlock)) > SNAPSHOT_BLOCK_TOLERANCE) return false;
        if(!this._gateActive('bridge', Number(row.snapshot_block))) return false;

        return hasTransfer ? await this._validateTransfer(row) : await this._validatePolicy(row);
    }

    async _validateTransfer(row){
        if(!allCanonicalInts(row, TRANSFER_CANONICAL_INT_FIELDS)) return false;
        if(!ALLOWED_CHAINS.includes(row.src_chain) || !ALLOWED_CHAINS.includes(row.dest_chain)) return false;
        if(row.src_chain === row.dest_chain) return false;
        if(String(row.network || '') !== String(this.network || '')) return false;
        if(String(row.tick) !== 'XCHAIN' && !this._gateActive('token', Number(row.snapshot_block))) return false;

        let res;
        try { res = await this._indexerCall(row.src_chain, 'getpendingbridgetransfers', { limit: PENDING_PAGE }); }
        catch(e){ return false; }
        if(!res || !Array.isArray(res.transfers)) return false;
        if(String(res.network || '') !== String(row.network || '')) return false;
        let latest = Number(res.latest_block_index);
        let leg = res.transfers.find(t => Number(t.src_action_index) === Number(row.src_action_index));
        if(!leg) return false;

        // Our OWN depth judgement, at the MIN_DEPTH our own indexer reports the lock stamped.
        let depth = latest - Number(leg.block_index) + 1;
        if(!Number.isFinite(depth) || depth < this._effectiveDepth(row.src_chain, leg.min_depth)) return false;

        let fieldsMatch =
            String(leg.src_address)  === String(row.src_address) &&
            String(leg.dest_chain)   === String(row.dest_chain) &&
            String(leg.dest_address) === String(row.dest_address) &&
            String(leg.tick)         === String(row.tick) &&
            Number(leg.decimals)     === Number(row.decimals) &&
            this._amountsEqual(leg.amount, row.amount) &&
            // push_generation is stamped but never signed, so a Byzantine leader could
            // otherwise inflate it and evade the fence a later source-keyed retraction
            // applies (<= retraction_generation). Pin it to our own indexer's view.
            (Number(leg.push_generation) || 0) === (Number(row.push_generation) || 0);
        if(!fieldsMatch) return false;

        let derived = this._deriveTransferId(row.network, row.src_chain, Number(row.src_action_index),
                                             row.dest_chain, row.dest_address, Number(row.snapshot_block));
        return String(derived).toLowerCase() === String(row.transfer_id).toLowerCase();
    }

    async _validatePolicy(row){
        if(!this._gateActive('policy', Number(row.snapshot_block))) return false;
        if(!allCanonicalInts(row, POLICY_CANONICAL_INT_FIELDS)) return false;
        if(!ALLOWED_CHAINS.includes(row.origin_chain)) return false;
        if(String(row.network || '') !== String(this.network || '')) return false;
        if(!Number.isInteger(Number(row.policy_seq)) || Number(row.policy_seq) < 1) return false;
        if(!/^[0-9a-f]{64}$/.test(String(row.policy_hash || '').toLowerCase())) return false;

        // Never co-sign a SECOND content at a seq we already finalized: that is exactly the
        // conflicting-canonical shape SLASH judges, and signing it would make this validator
        // provably equivocating over its own record.
        let held = await this.db.getPolicySnapshotAtSeq(row.network, row.origin_chain, row.tick, Number(row.policy_seq));
        if(held && String(held.policy_hash).toLowerCase() !== String(row.policy_hash).toLowerCase()) return false;

        // Our own read, at the SAME origin_block, from our own origin indexer. A read
        // FAILURE abstains (no co-signature, the round retries next cycle); it never
        // refuses, because an unreachable indexer is our problem, not the leader's.
        let policy;
        try { policy = await this._indexerCall(row.origin_chain, 'gettokenpolicy',
                                               { tick: row.tick, origin_block: Number(row.origin_block) }); }
        catch(e){ return false; }
        if(!policy || policy.error) return false;

        let shaped = this._shapePolicy(policy);
        if(!shaped || shaped.oversized) return false;
        let hash = this._policyHash(shaped.allow, shaped.block, shaped.sleeping);
        if(hash !== String(row.policy_hash).toLowerCase()) return false;

        // The transport arrays must hash to the hash we just agreed on, or every destination
        // would refuse the row after we had already signed it.
        let asArray = (v) => {
            if(v === null || v === undefined) return null;
            try { let p = JSON.parse(v); return Array.isArray(p) ? p.map(String) : undefined; }
            catch(e){ return undefined; }
        };
        let allow = asArray(row.allow_list);
        let block = asArray(row.block_list);
        if(allow === undefined || block === undefined) return false;
        if(!this._isCanonicalOrder(allow) || !this._isCanonicalOrder(block)) return false;
        if(this._policyHash(allow, block, Number(row.sleeping) === 1) !== hash) return false;

        let derived = this._deriveSnapshotId(row.network, row.origin_chain, row.tick,
                                             Number(row.policy_seq), Number(row.snapshot_block));
        return String(derived).toLowerCase() === String(row.snapshot_id).toLowerCase();
    }

    // ---------------------------------------------------------------------------
    // Persistence and mirroring
    // ---------------------------------------------------------------------------

    async _writeFinalizedTransfer(ev){
        let row = ev.row;
        row.validator_signatures = JSON.stringify(ev.signatures || []);
        row.finalizing_view      = ev.view != null ? ev.view : 0;
        if(!await this._persistSnapshotOrDefer(row, row.transfer_id, this.transferConsensus)) return;
        row.btc_chain_id = await this._resolveBtcChainId(row.network);
        let inserted;
        try { inserted = await this.db.insertBridgeTransfer(row); }
        catch(e){
            console.error('CrossChainBridge: finalized transfer write FAILED (fail-closed; deferring ' +
                          String(row.transfer_id).substring(0, 16) + '... to a later round): ' + (e && e.message));
            this._defer(row.transfer_id, this.transferConsensus);
            return;
        }
        this._inflight.delete(row.transfer_id);
        if(!inserted) return;
        await this._mirrorRow('bridge_transfers', 'transfer_id', row.transfer_id);
        console.log('CrossChainBridge: finalized transfer ' + String(row.transfer_id).substring(0, 16) + '... ' +
                    row.src_chain + ':' + row.src_action_index + ' -> ' + row.dest_chain + ' ' +
                    row.amount + ' ' + row.tick + ' (' + (ev.signatures ? ev.signatures.length : 0) + ' sigs)');
        this.emit('transfer:finalized', { transferId: row.transfer_id });
    }

    async _writeFinalizedPolicy(ev){
        let row = ev.row;
        row.validator_signatures = JSON.stringify(ev.signatures || []);
        row.finalizing_view      = ev.view != null ? ev.view : 0;
        if(!await this._persistSnapshotOrDefer(row, row.snapshot_id, this.policyConsensus)) return;
        row.btc_chain_id = await this._resolveBtcChainId(row.network);
        let inserted;
        try { inserted = await this.db.insertPolicySnapshot(row); }
        catch(e){
            console.error('CrossChainBridge: finalized policy snapshot write FAILED (fail-closed; deferring ' +
                          String(row.snapshot_id).substring(0, 16) + '... to a later round): ' + (e && e.message));
            this._defer(row.snapshot_id, this.policyConsensus);
            return;
        }
        this._inflight.delete(row.snapshot_id);
        if(!inserted) return;
        await this._mirrorRow('policy_snapshots', 'snapshot_id', row.snapshot_id);
        console.log('CrossChainBridge: finalized policy snapshot ' + String(row.snapshot_id).substring(0, 16) +
                    '... ' + row.origin_chain + ':' + row.tick + ' seq ' + row.policy_seq +
                    ' (' + (ev.signatures ? ev.signatures.length : 0) + ' sigs)');
        this.emit('policy:finalized', { snapshotId: row.snapshot_id });
    }

    // EVERY hub persists the capability snapshot for the row's snapshot_block, not just the
    // round leader: indexers verify a row's signatures against capability_snapshots in
    // whichever hub DB they mirror, and a follower's DB may be the only one they read.
    //
    // FAIL CLOSED, the rule CrossChainDexEngine._writeFinalizedMatch spells out in full: the
    // persist is a PRECONDITION of the row, not a best-effort side write. A swallowed throw,
    // or a silent zero-row persist (the sentinel snapshot degrades to [] on an indexer RPC
    // error or a 401, so the insert loop never runs and never warns), would leave a
    // finalized, mirrored record whose signatures no mirror can verify. Returns false when
    // the caller must skip the write; the round is deferred so a later poll re-proposes it.
    async _persistSnapshotOrDefer(row, roundId, consensus){
        let persisted = 0;
        try {
            persisted = await this._persistCapabilitySnapshot('cross_chain', Number(row.snapshot_block), row.network);
        } catch(e){
            console.error('CrossChainBridge: snapshot persist on finalize FAILED (fail-closed; deferring ' +
                          String(roundId).substring(0, 16) + '... to a later round): ' + (e && e.message));
            this._defer(roundId, consensus);
            return false;
        }
        if(!persisted){
            console.error('CrossChainBridge: snapshot persist wrote ZERO capability rows for snapshot_block ' +
                          row.snapshot_block + ' (degraded or empty validator set; fail-closed, deferring ' +
                          String(roundId).substring(0, 16) + '... to a later round)');
            this._defer(roundId, consensus);
            return false;
        }
        return true;
    }

    // Release a round that finalized in PBFT but whose write refused or failed, so the next
    // poll re-proposes it. BOTH releases are needed: _inflight gates the poll and the
    // consensus finalized-ring refuses to re-run a round id it has retired.
    _defer(roundId, consensus){
        this._inflight.delete(roundId);
        if(consensus && typeof consensus.forgetFinalized === 'function') consensus.forgetFinalized(roundId);
    }

    // Stream a row this hub has ALREADY committed to hub-DB mirror subscribers. Never
    // throws: the write is durable, so a delivery failure must not skip the caller's tail. A
    // throw from the re-read and a zero-row result are the same undeliverable-row event, and
    // dropAllForResync is the sanctioned repair, because the watermark heartbeat advances on
    // its own wall clock and would otherwise certify completeness past a committed row.
    async _mirrorRow(table, keyColumn, keyValue){
        let b = this.broadcaster;
        if(!b) return;
        if(b.subscribers && b.subscribers.size === 0) return;
        let failure = null;
        try {
            let read = await this.db.doQuery('SELECT * FROM ' + table + ' WHERE ' + keyColumn + ' = ? LIMIT 1', [keyValue]);
            if(read && read.length){
                b.broadcastRow({ table: table, row: read[0] });
                return;
            }
            failure = 'the committed row read back empty';
        } catch(e){
            failure = (e && e.message) ? e.message : String(e);
        }
        console.error('CrossChainBridge: could not stream a committed ' + table + ' row to mirror subscribers (' +
                      failure + '); forcing subscriber resync');
        try { if(typeof b.dropAllForResync === 'function') b.dropAllForResync(table + ' mirror gap'); }
        catch(_e){ /* the repair itself must never fail a committed row */ }
    }

    // ---------------------------------------------------------------------------
    // Retraction
    // ---------------------------------------------------------------------------

    // Mark transfer records whose SOURCE leg was rolled back as retracted and broadcast the
    // deletion so indexers drop the mirrored row. A record that has NOT been applied is then
    // never applied; one already applied stays applied (D16, milestone 1 ships no
    // destination-side unwind), the invariant read reports the deficit and the watch CRITs.
    //
    // toActionIndex bounds a DEFERRED retraction to a CLOSED range so a leg re-published
    // inside the original open-ended range is not retracted; retractionGeneration fences it
    // to rows stamped at or below that generation, so a leg re-finalized at a recycled
    // source action_index survives. Both absent means the open-ended live behaviour.
    //
    // policy_snapshots has NO retraction path on purpose: the table is append-only, a later
    // policy_seq supersedes, and it carries no source-chain action index for a range delete.
    async retractTransfersForReorg(chain, fromActionIndex, toActionIndex, retractionGeneration){
        let bounds = normalizeRetractionBounds(fromActionIndex, toActionIndex, retractionGeneration);
        if(bounds.error) throw new Error(bounds.error);
        let { from, to, gen, bounded, fenced } = bounds;
        let where = "status = 'finalized' AND src_chain = ? AND src_action_index >= ?" +
                    (bounded ? ' AND src_action_index <= ?' : '') +
                    (fenced  ? ' AND push_generation <= ?' : '');
        let params = [chain, from];
        if(bounded) params.push(to);
        if(fenced)  params.push(gen);
        let rows = await this.db.doQuery(
            'SELECT transfer_id FROM bridge_transfers WHERE ' + where, params);
        for(let r of rows){
            await this.db.doQuery(
                "UPDATE bridge_transfers SET status = 'retracted' WHERE transfer_id = ?", [r.transfer_id]);
            this._inflight.delete(r.transfer_id);
            // Clear the consensus finalized-ring entry: the transfer_id is the round id, and
            // without this a transfer re-formed after this reorg could never re-finalize.
            this.transferConsensus.forgetFinalized(r.transfer_id);
            if(this.broadcaster){
                let evt = { table: 'bridge_transfers', source_chain: chain, from_action_index: from };
                if(bounded) evt.to_action_index = to;
                if(fenced)  evt.retraction_generation = gen;
                // Ride the retraction-signing round when active (a quorum-class retraction is
                // co-signed and the round dedupes the per-row repeats by canonical); legacy
                // unsigned broadcast otherwise.
                if(this.hub && this.hub.retractionConsensus)
                    this.hub.retractionConsensus.submitLocal(evt).catch(e =>
                        console.error('CrossChainBridge: retraction submit error: ' + (e && e.message)));
                else
                    this.broadcaster.broadcastDeletion(evt);
            }
        }
        return rows.length;
    }

    // ---------------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------------

    // The bridge invariant, keyed tick -> chain (base spec section 13, token spec section 4,
    // policy spec section 10). THE INVARIANT IS AN INEQUALITY: escrow >= supply, modulo
    // in-flight. Nothing refuses a user credit to a protocol role address, so a plain SEND
    // can land value on an escrow with no record behind it. That is a SURPLUS, the sender's
    // own loss like a send to the burn address, and the watch WARNs. A DEFICIT is the only
    // direction in which somebody else's units have nothing behind them, and is a forgery or
    // a reorg: the watch CRITs (D65).
    //
    // in_flight is everything the destination has not credited yet: legs mined but not at
    // depth (from the live poll), plus finalized records whose effective_time has not
    // passed. A record whose time HAS passed but whose mirror has not landed reads as a
    // small surplus, never a deficit, which is the safe direction for an alarm.
    //
    // escrow and supply are CHAIN state and no hub table holds them, so the chain half comes
    // from the indexers over `getbridgebalances` (_readBridgeBalances below). `chainStateReader`
    // stays as the injection point a test or an operator tool can substitute; its contract is
    // that of the default reader, async (coin, network, ticks) -> { tick: { supply, escrow } },
    // with `escrow` the map of ADDRESS.BRIDGE_<COIN> balances held ON `coin`. Whenever a read
    // fails or the method is absent the affected fields stay null, which the watch item reads
    // as UNKNOWN and never as a deficit.
    //
    // Which chain each half is read from is the whole point of the invariant (base spec
    // section 3): a copy chain C's SUPPLY is read on C, while the escrow BACKING it is a
    // balance on the tick's ORIGIN chain at ADDRESS.BRIDGE_C. Reading both halves on C would
    // report every healthy copy as a deficit of its entire supply, because no copy chain
    // escrows its own units.
    async getBridgeInvariant(tick){
        let network = this.network;
        let now     = this._nowSeconds();
        let out     = {};
        let entry   = (t, c) => {
            out[t] = out[t] || {};
            out[t][c] = out[t][c] || { escrow: null, supply: null, in_flight: '0', delta: null, finalized_policy_seq: null };
            return out[t][c];
        };

        // XCHAIN is always present (D28 of the token spec), so an explorer or watch item can
        // read the base asset's invariant on a chain that has never carried a token leg.
        if(!tick || String(tick) === 'XCHAIN'){
            for(let c of ALLOWED_CHAINS) entry('XCHAIN', c);
        }

        let pairs = [];
        try { pairs = await this.db.getBridgeTransferChainPairs(network); }
        catch(e){ pairs = []; }
        for(let p of pairs){
            if(tick && String(p.tick) !== String(tick)) continue;
            entry(String(p.tick), String(p.src_chain));
            entry(String(p.tick), String(p.dest_chain));
        }

        // Signed-but-not-yet-applyable records.
        let flight = [];
        try { flight = await this.db.getInFlightBridgeTransfers(network, now, tick || null); }
        catch(e){ flight = []; }
        for(let f of flight){
            let e = entry(String(f.tick), String(f.dest_chain));
            e.in_flight = bc.bcstr(bc.bcadd(e.in_flight, this._normalizeAmount(f.amount) || '0', AMOUNT_SCALE));
        }
        // Mined-but-not-yet-finalized legs, from the last completed poll.
        for(let [key, amounts] of this._pendingInFlight){
            let sep = key.lastIndexOf('|');
            let t   = key.slice(0, sep);
            let c   = key.slice(sep + 1);
            if(tick && t !== String(tick)) continue;
            let e = entry(t, c);
            for(let a of amounts)
                e.in_flight = bc.bcstr(bc.bcadd(e.in_flight, this._normalizeAmount(a) || '0', AMOUNT_SCALE));
        }

        // Latest FINALIZED policy seq per tick. The hub knows only what it finalized; the
        // APPLIED seq is read per destination through the indexer's getappliedpolicy.
        for(let t of Object.keys(out)){
            let origin = this._tickOrigin.get(network + '|' + t);
            if(!origin) continue;
            let seq;
            try { seq = await this.db.getLatestPolicySeq(network, origin, t); }
            catch(e){ seq = 0; }
            if(!seq) continue;
            for(let c of Object.keys(out[t])) out[t][c].finalized_policy_seq = seq;
        }

        // Read each chain once, then assemble. A reader that throws takes only its own chain
        // out of the answer; the rest of the read still serves what the hub can prove.
        let reader = (typeof this.chainStateReader === 'function')
            ? this.chainStateReader
            : (c, n, t) => this._readBridgeBalances(c, n, t);
        let readings = {};
        for(let c of ALLOWED_CHAINS){
            let ticks = Object.keys(out).filter(t => out[t][c]);
            if(!ticks.length) continue;
            try { readings[c] = await reader(c, network, ticks); }
            catch(e){ readings[c] = null; }
        }
        for(let t of Object.keys(out)){
            // The tick's origin, learned from the pending read's transfer_kind. XCHAIN is
            // native on BTC by construction (base spec section 4: the v0 lock is BTC-only),
            // so its origin is known before this hub has seen a single leg. A token whose
            // origin is not learned yet reports escrow and delta as null rather than reading
            // a backing balance off a chain that does not hold the escrow.
            let origin     = this._tickOrigin.get(network + '|' + t) || (t === 'XCHAIN' ? 'BTC' : null);
            let originRead = (origin && readings[origin]) ? readings[origin][t] : null;
            for(let c of Object.keys(out[t])){
                let e   = out[t][c];
                let own = readings[c] ? readings[c][t] : null;
                if(own && own.supply != null) e.supply = String(own.supply);
                // The origin holds the asset itself; nothing escrows it there, so it carries
                // no escrow and no delta. Every other chain holds a copy backed by BRIDGE_<c>
                // on the origin, and that pair is the inequality the watch alarms on.
                if(!origin || c === origin) continue;
                let held = originRead ? this._escrowFor(originRead.escrow, c) : null;
                if(held != null) e.escrow = String(held);
                if(e.escrow != null && e.supply != null)
                    e.delta = bc.bcstr(bc.bcsub(e.escrow,
                        bc.bcadd(e.supply, e.in_flight, AMOUNT_SCALE), AMOUNT_SCALE));
            }
        }
        return out;
    }

    // The balance a getbridgebalances answer reports for one destination chain's escrow. The
    // indexer keys the map by the ROLE it read (ADDRESS.BRIDGE_<COIN>), so both the bare coin
    // and the full role name are accepted; anything else is absent, never zero, because a
    // fabricated zero on a live copy reads as a total deficit.
    _escrowFor(escrowMap, coin){
        if(!escrowMap || typeof escrowMap !== 'object') return null;
        if(escrowMap[coin] != null) return escrowMap[coin];
        if(escrowMap['BRIDGE_' + coin] != null) return escrowMap['BRIDGE_' + coin];
        return null;
    }

    // Default chain-state reader: each chain's own indexer over the SAME per-chain client the
    // pending-leg poll uses (one URL and key per coin, resolved at construction and topped up
    // from the configs table in start()). getbridgebalances answers for one tick at a time
    // with that tick's supply on this chain plus the balance at every ADDRESS.BRIDGE_<COIN>
    // role address this chain carries (base spec section 13 names the read; the indexer half
    // lands on the same train). Until it exists, or whenever a chain is unreachable, the read
    // degrades to null for that chain with ONE line per chain per process: a poll runs every
    // 15 s and an unreadable chain is an operator condition, not a per-tick event.
    async _readBridgeBalances(coin, network, ticks){
        let out = null;
        for(let t of (ticks || [])){
            let res;
            try { res = await this._indexerCall(coin, 'getbridgebalances', { tick: t }); }
            catch(e){ this._logChainStateDegraded(coin, e); return out; }
            if(!res || res.error) continue;
            out = out || {};
            out[t] = {
                supply: (res.supply != null) ? res.supply : null,
                escrow: res.escrow || null
            };
        }
        return out;
    }

    _logChainStateDegraded(coin, err){
        if(this._chainStateLogged[coin]) return;
        this._chainStateLogged[coin] = true;
        console.warn('CrossChainBridge: getbridgebalances is unreadable on ' + coin + ' (' +
                     (err && err.message) + '); getbridgeinvariant serves escrow, supply and delta ' +
                     'as null for that chain until the indexer answers it');
    }

    // ---------------------------------------------------------------------------
    // Shared plumbing (the sibling engines' helpers, kept in lockstep by design)
    // ---------------------------------------------------------------------------

    async _resolveCapabilityValidators(capability, block, network){
        let validators = [];
        let weighted = swq.isStakeWeightedQuorumActive(block, network);
        if(this.capSnapshot){
            if(weighted){
                let snap = await this.capSnapshot.getWeightSnapshot(capability, block);
                if(snap && Array.isArray(snap.validators)){
                    validators = snap.validators.map(v => ({
                        pubkey: v.pubkey, source: String(v.source != null ? v.source : ''),
                        weight: String(v.weight != null ? v.weight : '0'),
                        amount: String(v.weight != null ? v.weight : '0')
                    }));
                    // Carry the truncation marker through the .map or the consensus cannot fail
                    // closed on an over-cap weighted snapshot (meetsStakeThreshold under-counts S).
                    if(snap.truncated === true) validators.truncated = true;
                }
            } else {
                let snap = await this.capSnapshot.getSnapshot(capability, block);
                if(snap && Array.isArray(snap.validators)){
                    validators = snap.validators.map(v => ({
                        pubkey: v.pubkey, source: '',
                        weight: String(v.amount != null ? v.amount : '0'),
                        amount: String(v.amount != null ? v.amount : '0')
                    }));
                    if(snap.truncated === true) validators.truncated = true;
                }
            }
        }
        if(validators.length === 0 && this._seedLocalValidator && this.identity){
            let pk = this.identity.getPubkeyHex();
            validators = [{ pubkey: pk, source: 'seed:' + String(pk).toLowerCase(), weight: '1', amount: '1' }];
        }
        return validators;
    }

    // Persist the qualifying validator set for (capability, block) and mirror each row, so
    // an off-BTC indexer can verify this record's signatures against a set it holds.
    // Returns the number of rows resolved; 0 is the fail-closed money-path signal.
    async _persistCapabilitySnapshot(capability, block, network){
        let validators = await this._resolveCapabilityValidators(capability, block, network);
        // A TRUNCATED set is never mirrored: the marker fails this hub's own threshold check
        // closed, but it is a JS array property with no column behind it, so persisting the
        // capped rows would let an off-BTC verifier read a partial set as COMPLETE. Zero rows
        // is the fail-closed answer in both directions.
        if(validators && validators.truncated === true){
            console.warn('CrossChainBridge: refusing to persist a TRUNCATED ' + capability +
                         ' capability snapshot at block ' + block +
                         ' (over the source cap; raise VALIDATOR_QUERY_LIMIT fleet-wide). No rows mirrored.');
            return 0;
        }
        let rows = await snapWrite.writeCapabilitySnapshotRows(
            this.db, capability, block, validators, await this._resolveBtcChainId(network));
        for(let row of rows){
            if(this.broadcaster){
                let r = await this.db.doQuery(
                    'SELECT * FROM capability_snapshots WHERE snapshot_block = ? AND capability = ? AND signing_pubkey = ? AND source = ? LIMIT 1',
                    [block, capability, row.signing_pubkey, row.source]);
                if(r.length) this.broadcaster.broadcastRow({ table: 'capability_snapshots', row: r[0] });
            }
        }
        return validators.length;
    }

    // The chain instance these records belong to (the hash of BTC block 1 on the chain this
    // hub's Bitcoin indexer follows). Stamped so a mirror that survived a re-genesis can
    // refuse a record minted on the dead chain. Transport, never signed, and a lookup
    // failure must never fail a finalized record, so it degrades to NULL.
    async _resolveBtcChainId(network){
        try {
            if(!this.db || typeof this.db.getChainTip !== 'function') return null;
            let tip = await this.db.getChainTip('bitcoin', network || this.network || '');
            return (tip && tip.chainId) ? tip.chainId : null;
        } catch(e){
            return null;
        }
    }

    async _indexerCall(coin, method, params){
        let ix = this.indexers[coin];
        if(!ix || !ix.url) throw new Error('no indexer url for ' + coin);
        let headers = { 'Content-Type': 'application/json' };
        if(ix.key) headers['x-api-key'] = ix.key;
        let resp = await axios.post(ix.url, { jsonrpc: '2.0', method, params: params || {}, id: 1 },
                                    { headers, timeout: 15000 });
        if(resp.data && resp.data.error) throw new Error('indexer RPC error: ' + JSON.stringify(resp.data.error));
        return resp.data ? resp.data.result : null;
    }

    // Trailing-zero-insensitive compare for the bcmath decimal strings the record carries.
    _normalizeAmount(v){
        if(v === null || v === undefined) return '';
        let s = String(v).trim();
        if(s === '') return '';
        let neg = s.startsWith('-');
        if(neg) s = s.slice(1);
        let out = s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
        out = out.replace(/^0+(?=\d)/, '');
        return (neg && out !== '0') ? '-' + out : out;
    }

    _amountsEqual(x, y){
        return this._normalizeAmount(x) === this._normalizeAmount(y);
    }

    _nowSeconds(){ return Math.floor(Date.now() / 1000); }

    // The BTC-anchored snapshot block. On a no-BTC regtest, fall back to the fixed
    // deterministic override the sibling engines share, so a record and the capability
    // snapshot it is verified against use one anchor.
    async _resolveSnapshotBlock(){
        let b = this.hub._resolveBtcLatestBlock ? await this.hub._resolveBtcLatestBlock() : null;
        if(b != null) return b;
        return Number.isFinite(this._snapshotBlockOverride) ? this._snapshotBlockOverride : null;
    }

}

module.exports = CrossChainBridgeEngine;
