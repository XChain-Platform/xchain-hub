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
 * XChain Hub - Bridge Invariant Read
 *
 * The escrow-versus-supply read the watch alarms on, per tick and chain: the hub's own
 * in-flight terms, the per-chain state read each indexer answers for, and the degraded
 * reading that reports null rather than inventing a deficit.
 *
 ********************************************************************/

const bc = require('../../bcmath.js');
const { ALLOWED_CHAINS, AMOUNT_SCALE } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {
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
    // from the indexers over `getbridgebalances` (readBridgeBalances below). `chainStateReader`
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
        let out     = await this.collectInvariantEntries(tick, network, now);

        // Read each chain once, then assemble. A reader that throws takes only its own chain
        // out of the answer; the rest of the read still serves what the hub can prove.
        let reader = (typeof this.chainStateReader === 'function')
            ? this.chainStateReader
            : (c, n, t) => this.readBridgeBalances(c, n, t);
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
                let held = originRead ? this.escrowFor(originRead.escrow, c) : null;
                if(held != null) e.escrow = String(held);
                if(e.escrow != null && e.supply != null)
                    e.delta = bc.bcstr(bc.bcsub(e.escrow,
                        bc.bcadd(e.supply, e.in_flight, AMOUNT_SCALE), AMOUNT_SCALE));
            }
        }
        return out;
    },

    // The invariant's entries before any chain is read: every (tick, chain) the hub's own
    // records name, the in-flight sums from finalized rows and the last poll, and the latest
    // finalized policy seq per tick.
    async collectInvariantEntries(tick, network, now){
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
            e.in_flight = bc.bcstr(bc.bcadd(e.in_flight, this.normalizeAmount(f.amount) || '0', AMOUNT_SCALE));
        }
        // Mined-but-not-yet-finalized legs, from the last completed poll.
        for(let [key, amounts] of this._pendingInFlight){
            let sep = key.lastIndexOf('|');
            let t   = key.slice(0, sep);
            let c   = key.slice(sep + 1);
            if(tick && t !== String(tick)) continue;
            let e = entry(t, c);
            for(let a of amounts)
                e.in_flight = bc.bcstr(bc.bcadd(e.in_flight, this.normalizeAmount(a) || '0', AMOUNT_SCALE));
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
        return out;
    },

    // The balance a getbridgebalances answer reports for one destination chain's escrow. The
    // indexer keys the map by the ROLE it read (ADDRESS.BRIDGE_<COIN>), so both the bare coin
    // and the full role name are accepted; anything else is absent, never zero, because a
    // fabricated zero on a live copy reads as a total deficit.
    escrowFor(escrowMap, coin){
        if(!escrowMap || typeof escrowMap !== 'object') return null;
        if(escrowMap[coin] != null) return escrowMap[coin];
        if(escrowMap['BRIDGE_' + coin] != null) return escrowMap['BRIDGE_' + coin];
        return null;
    },

    // Default chain-state reader: each chain's own indexer over the SAME per-chain client the
    // pending-leg poll uses (one URL and key per coin, resolved at construction and topped up
    // from the configs table in start()). getbridgebalances answers for one tick at a time
    // with that tick's supply on this chain plus the balance at every ADDRESS.BRIDGE_<COIN>
    // role address this chain carries (base spec section 13 names the read; the indexer half
    // lands on the same train). Until it exists, or whenever a chain is unreachable, the read
    // degrades to null for that chain with ONE line per chain per process: a poll runs every
    // 15 s and an unreadable chain is an operator condition, not a per-tick event.
    async readBridgeBalances(coin, network, ticks){
        let out = null;
        for(let t of (ticks || [])){
            let res;
            try { res = await this.indexerCall(coin, 'getbridgebalances', { tick: t }); }
            catch(e){ this.logChainStateDegraded(coin, e); return out; }
            if(!res || res.error) continue;
            out = out || {};
            out[t] = {
                supply: (res.supply != null) ? res.supply : null,
                escrow: res.escrow || null
            };
        }
        return out;
    },

    logChainStateDegraded(coin, err){
        if(this._chainStateLogged[coin]) return;
        this._chainStateLogged[coin] = true;
        logger.warn('CrossChainBridge: getbridgebalances is unreadable on ' + coin + ' (' +
                     (err && err.message) + '); getbridgeinvariant serves escrow, supply and delta ' +
                     'as null for that chain until the indexer answers it');
    },
};
