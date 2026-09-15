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
 * XChain Hub - Bridge Transfer Poll
 *
 * Discovery of confirmed source legs and the transfer round each one opens: the activation
 * gate every family is judged against, the per-chain pending read, the depth and guard
 * checks that decide whether a leg is proposed, and the held-leg log that says why not.
 *
 ********************************************************************/

const bc = require('../../bcmath.js');
const { relayMarginFloorS } = require('../../lib/relay_margin.js');
const { ALLOWED_CHAINS, PENDING_PAGE } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {
    // The bookkeeping carried between polls: the round and source-leg guards, the held-leg
    // log memo, and the pending-leg and tick-origin views the invariant and policy polls read.
    initTransferState(){
        // Round ids in PBFT but not yet written (the sibling engines' _inflight).
        this._inflight = new Set();

        // SOURCE LEG guard: at most one in-flight round per (network, src_chain,
        // src_action_index). transfer_id is now a pure function of the source leg (no
        // snapshot_block in the preimage, see deriveTransferId), so this key and the
        // _inflight key above name the same round; the guard is kept as the independent
        // refusal the follower path (validateTransfer) consults, and so that a transfer_id
        // whose preimage ever widens again cannot silently reopen the double-round window.
        // A leg is guarded from propose through finalize/abandon/defer.
        this._inflightSourceLegs  = new Set();
        this._inflightTransferLeg = new Map();  // transfer_id -> source leg key, for release

        // Legs whose early return in maybeFinalizeTransfer has already been logged, keyed
        // `<leg>|<reason>`, so a 15 s poll reports a held or refused leg ONCE per process
        // instead of every tick. Bounded FIFO: a long-lived hub sees many legs.
        this._earlyReturnLogged = new Set();

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
    },

    // ---------------------------------------------------------------------------
    // Activation
    // ---------------------------------------------------------------------------

    // Is a gate armed for `block` on this hub's network, for the chain `coin` whose height
    // `block` is? Fails CLOSED on a missing predicate (an unvendored flag-day twin) and logs
    // the reason once per gate, so an operator sees why the engine is idle instead of
    // watching it quietly sign nothing.
    //
    // The coin is passed to every family even though only the bridge map is keyed
    // '<COIN>:<network>' today: the token and policy predicates take (block, network) and
    // ignore the extra argument, so one call shape serves all three and a later coin-keying
    // of either map needs no new call site. A height is only ever meaningful with the chain
    // it was measured on, so the two travel together.
    gateActive(name, block, coin){
        let fn = this.activation && this.activation[name];
        if(typeof fn !== 'function'){
            if(!this._idleLogged[name]){
                this._idleLogged[name] = true;
                logger.warn('CrossChainBridge: the ' + name + ' activation module is not readable in this hub; ' +
                             'the engine stays idle for that family (fail closed) until the flag-day twin is vendored');
            }
            return false;
        }
        try { return !!fn(block, this.network, coin); }
        catch(e){ return false; }
    },

    // ---------------------------------------------------------------------------
    // Poll
    // ---------------------------------------------------------------------------

    async _poll(){
        if(this._polling) return;               // never overlap a slow poll
        this._polling = true;
        try {
            let snapshotBlock = await this.resolveSnapshotBlock();
            if(snapshotBlock == null) return;   // no anchor: sign nothing this tick
            // A hub on a pre-activation network never polls (base spec section 7). The gate
            // is keyed on the BTC-anchored snapshot block, the same anchor that selects the
            // validator set, so every hub in the federation flips on one height. That block
            // is a BTC height, so it is judged against the BTC key: this is the federation's
            // "is the bridge live at all" test, and each chain's own flag day is then
            // checked per leg in maybeFinalizeTransfer against that chain's own height.
            if(!this.gateActive('bridge', snapshotBlock, 'BTC')) return;
            let pending = new Map();
            for(let coin of ALLOWED_CHAINS){
                if(!this.indexers[coin] || !this.indexers[coin].url) continue;
                try { await this.pollPendingTransfers(coin, snapshotBlock, pending); }
                catch(e){ logger.warn('CrossChainBridge: pending poll failed on ' + coin + ': ' + (e && e.message)); }
            }
            // Swap the in-flight view in only after a full sweep, so a chain that failed
            // mid-pass cannot drop its legs out of the invariant and turn a healthy read
            // into a phantom surplus.
            this._pendingInFlight = pending;
            if(this.gateActive('policy', snapshotBlock, 'BTC')){
                try { await this.pollPolicySnapshots(snapshotBlock); }
                catch(e){ logger.warn('CrossChainBridge: policy poll failed: ' + (e && e.message)); }
            }
        } finally {
            this._polling = false;
        }
    },

    // Discover confirmed source legs on `coin` and run a transfer round for each.
    async pollPendingTransfers(coin, snapshotBlock, pendingOut){
        let res;
        try { res = await this._indexerCall(coin, 'getpendingbridgetransfers', { limit: PENDING_PAGE }); }
        catch(e){ return; }
        if(!res || !Array.isArray(res.transfers) || !res.network) return;
        let latest = Number(res.latest_block_index);
        if(!Number.isFinite(latest)) return;
        let network = String(res.network);
        // Legs this hub has ALREADY finalized are neither in flight nor proposable, whatever
        // the indexer still lists: its mirror of bridge_transfers can lag the hub's own
        // write by a mirror round trip, and a lagging (or unfiltered) answer would count a
        // settled leg into the invariant's in-flight term a second time, on top of the
        // finalized-but-not-yet-effective rows getInFlightBridgeTransfers already sums.
        // One set read per chain per poll, keyed on the source action index.
        let persisted = await this.db.getBridgeTransferSourceIndexes(
            network, coin, res.transfers.map(t => Number(t && t.src_action_index)));
        for(let t of res.transfers){
            if(persisted.has(Number(t && t.src_action_index))) continue;
            // Every other pending leg is in flight from the moment its source is mined,
            // whether or not it has reached depth: the origin escrow already holds the value
            // and the destination has not minted it.
            this.recordPending(pendingOut, t);
            try { await this.maybeFinalizeTransfer(coin, network, latest, snapshotBlock, t); }
            catch(e){ logger.warn('CrossChainBridge: transfer round failed for ' + coin + ':' +
                                   String(t && t.src_action_index) + ': ' + (e && e.message)); }
        }
    },

    recordPending(pendingOut, t){
        if(!t || !t.tick || !t.dest_chain) return;
        let key = String(t.tick) + '|' + String(t.dest_chain);
        let arr = pendingOut.get(key) || [];
        arr.push(String(t.amount));
        pendingOut.set(key, arr);
    },

    // The depth this federation waits for before it signs a leg on `coin`: the platform
    // default raised, never lowered, by the origin row's MIN_DEPTH as the lock STAMPED it
    // at its own block (token spec section 7, D24). Stamped rather than re-read at poll
    // time, so a later edit of the origin row can never make an accepted lock un-signable
    // and two followers can never disagree. Nothing is signed for it.
    effectiveDepth(coin, minDepth){
        let platform = Number(this.confirmations[coin]);
        if(!Number.isFinite(platform) || platform <= 0) platform = 1;
        let raised = Number(minDepth);
        if(!Number.isFinite(raised) || raised <= 0) return platform;
        return Math.max(platform, raised);
    },

    // Release both halves of the source-leg guard for one transfer round: the plain
    // _inflight entry every sibling engine keys by round id, and the source-leg entry this
    // engine keys additionally by (network, src_chain, src_action_index) (constructor
    // comment). Called on abandon, on defer, and after a finalize write (successful or a
    // no-op duplicate), so a leg is never left guarded under a transfer_id whose round has
    // already ended.
    releaseSourceLegGuard(transferId){
        // The consensus lowercases every round id it emits; a sha256 hex digest already is,
        // so this is a no-op on an honest id and a guarantee for the Map lookup below.
        transferId = String(transferId).toLowerCase();
        this._inflight.delete(transferId);
        let legKey = this._inflightTransferLeg.get(transferId);
        if(legKey){
            this._inflightSourceLegs.delete(legKey);
            this._inflightTransferLeg.delete(transferId);
        }
    },

    // One line per (leg, reason) per process for a leg the poll saw and did not propose.
    // A silent early return makes a hub that "stops proposing" read exactly like one that
    // is refusing, so every hold below says why, in the log.
    logHeld(coin, t, reason){
        let leg = coin + ':' + String(t && t.src_action_index);
        let key = leg + '|' + reason;
        if(this._earlyReturnLogged.has(key)) return;
        if(this._earlyReturnLogged.size >= 10000)
            this._earlyReturnLogged.delete(this._earlyReturnLogged.values().next().value);
        this._earlyReturnLogged.add(key);
        logger.info('CrossChainBridge: not proposing ' + leg + ' (' + reason + ')');
    },

    async maybeFinalizeTransfer(coin, network, latestBlock, snapshotBlock, t){
        let leg = await this.admitTransferLeg(coin, network, latestBlock, snapshotBlock, t);
        if(!leg) return;
        let { destChain, tick, srcActionIndex, transferId, sourceLegKey } = leg;

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
        if(!Number.isInteger(row.decimals) || row.decimals < 0 || row.decimals > 18) return this.logHeld(coin, t, 'decimals ' + t.decimals + ' out of range');
        if(!row.src_address || !row.dest_address) return this.logHeld(coin, t, 'missing src_address or dest_address');
        if(bc.bclte(this.normalizeAmount(row.amount) || '0', 0)) return this.logHeld(coin, t, 'amount ' + t.amount + ' is not positive');

        // A transfer is read by dest_chain alone, so its map has one entry.
        if(!await this.stampAdmission('bridge_transfers', row, 'transfer ' + transferId)) return;

        let validators = await this.resolveCapabilityValidators('cross_chain', Number(snapshotBlock), network);
        this._inflight.add(transferId);
        this._inflightSourceLegs.add(sourceLegKey);
        this._inflightTransferLeg.set(transferId, sourceLegKey);
        try {
            await this.transferConsensus.propose(transferId, {
                row: row, snapshot: { validators: validators, count: validators.length }
            });
        } catch(e){
            this.releaseSourceLegGuard(transferId);
            throw e;
        }
    },

    // Every reason a pending leg is not proposed this tick, each logged once through logHeld,
    // or the leg's identity when it is. The follower applies the same gates on its own view.
    async admitTransferLeg(coin, network, latestBlock, snapshotBlock, t){
        if(!t) return;
        let kind = String(t.transfer_kind || '');
        if(kind !== 'lock' && kind !== 'burn') return this.logHeld(coin, t, 'transfer_kind ' + kind + ' is not a source leg');
        let destChain = String(t.dest_chain || '');
        if(!ALLOWED_CHAINS.includes(destChain) || destChain === coin) return this.logHeld(coin, t, 'dest_chain ' + destChain + ' is not bridgeable from ' + coin);
        let tick = String(t.tick || '');
        if(!tick) return this.logHeld(coin, t, 'no tick');
        // A general-token leg needs the token-bridge gate as well as the bridge gate; the
        // base spec's own legs are XCHAIN and ride the bridge gate alone. The parity test
        // pins TOKEN_BRIDGE_ACTIVATION >= XCHAIN_BRIDGE_ACTIVATION for every chain key, so
        // this can never arm v3/v4 without an engine behind it. The token map is
        // network-keyed and the snapshot block is BTC's, so the coin travels with the height.
        if(tick !== 'XCHAIN' && !this.gateActive('token', snapshotBlock, 'BTC'))
            return this.logHeld(coin, t, 'token bridge not active at snapshot_block ' + snapshotBlock);

        // The SOURCE CHAIN's own flag day, read at the height this leg was mined, which is
        // the same (block, coin) pair the indexer verdicts the action against. The map is
        // keyed '<COIN>:<network>' and the three chains arm at three heights, so the
        // BTC-anchored gate in _poll cannot speak for a leg mined on LTC or DOGE: without
        // this the hub would sign an LTC leg the moment BTC crossed its instant. The
        // follower re-applies the identical test in validateTransfer, so proposer and
        // validator refuse on the same height rather than disagreeing across the boundary.
        if(!this.gateActive('bridge', Number(t.block_index), coin))
            return this.logHeld(coin, t, 'bridge not active on ' + coin + ' at block ' + t.block_index);

        let srcActionIndex = Number(t.src_action_index);
        if(!Number.isInteger(srcActionIndex) || srcActionIndex <= 0) return this.logHeld(coin, t, 'src_action_index is not a positive integer');

        // Confirmation gate: the only defence against signing a reorg-able source leg. An
        // applied mint is final on a destination that did not reorg (D16), so the depth is
        // the attacker's price for that loss.
        let depth = latestBlock - Number(t.block_index) + 1;
        if(!Number.isFinite(depth) || depth < this.effectiveDepth(coin, t.min_depth))
            // The reason carries the floor, never the current depth: a depth that grows by one
            // per block would defeat the once-per-reason memo and log every block until it clears.
            return this.logHeld(coin, t, 'below depth ' + this.effectiveDepth(coin, t.min_depth));

        // The origin chain of this tick, learned from the leg's own kind: a lock is mined on
        // the chain the token is native to, a burn on a chain that holds a copy.
        this._tickOrigin.set(network + '|' + tick, kind === 'lock' ? coin : destChain);

        let transferId = this.deriveTransferId(network, coin, srcActionIndex, destChain, String(t.dest_address || ''));
        if(this._inflight.has(transferId)) return this.logHeld(coin, t, 'round ' + transferId.substring(0, 16) + '... still in flight');
        // Source-leg guard, the proposer's own refusal of a second round for one lock
        // (DEFECT 1: BTC action 95 finalized at both 1017 and 1018 when the id still moved
        // with the snapshot height); validateTransfer below is the follower's independent
        // one, so a proposer that skipped this cannot get a duplicate signed either.
        let sourceLegKey = network + '|' + coin + ':' + srcActionIndex;
        if(this._inflightSourceLegs.has(sourceLegKey)) return this.logHeld(coin, t, 'source leg guarded by an open round');
        if(await this.db.bridgeTransferExistsForSource(network, coin, srcActionIndex))
            return this.logHeld(coin, t, 'already finalized in bridge_transfers');
        return { destChain, tick, srcActionIndex, transferId, sourceLegKey };
    },
};
