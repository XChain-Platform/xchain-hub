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
 * XChain Hub - DEX Matching
 *
 * Discovery and pairing: each chain's open book, the swap and order compatibility tests,
 * price-time priority, and the descriptor a matched pair produces. The bottleneck clamp
 * itself stays in the engine file, beside the precision the indexer's matcher shares.
 *
 ********************************************************************/

const bc = require('../../bcmath.js');
const nodeUtil = require('node:util');
const { ALLOWED_CHAINS } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {
    async discoverAndMatch(){
        // Poll self-overlap guard (house convention: FullNodeChallengeRound.tick,
        // AttestationRound.pollPending). The poll is a bare setInterval at 15s while one
        // pass makes three paged indexer round trips plus a PBFT round and its DB writes,
        // so a slow indexer lets the next interval fire on top of this one. Two overlapping
        // passes read the SAME order books and the same this.committed ledger (which only
        // advances in writeFinalizedMatch, after consensus), so both derive the same fills;
        // the _inflight matchId reservation does not stop them, because the has() test in
        // finalizeMatch sits two awaits before the matching add(), and a snapshot block
        // that moved between the passes gives the second one a DIFFERENT matchId for the
        // same offers anyway. Result: the same offer proposed into two PBFT rounds and
        // double-committed against a single escrow. The finally is load-bearing: a rejected
        // fetchOpenOffers or resolveSnapshotBlock must not wedge matching forever.
        if(this._matching) return;
        this._matching = true;
        try {
            // Reservation-ledger gate. effectiveRemaining below subtracts this.committed
            // from the full offer amount, so a tick that runs against a ledger which never
            // rebuilt re-offers escrow already locked into finalized matches. Retry the
            // rebuild on this tick rather than on a second timer, and propose nothing until
            // it succeeds; every other engine startCrossChain brings up stays running.
            if(!this._committedReady && !(await this.rebuildCommitted())) return;
            let offersByCoin = {};
            // Fetch each coin's order book in parallel: the three RPC calls are fully
            // independent (each populates its own offersByCoin slot) and matching runs
            // only after all books are collected, so parallelising cuts ~2x per-coin
            // latency from every poll tick without changing which offers are matched or
            // in what order. Per-coin try/catch is preserved so one slow/failed indexer
            // still yields an empty book for that coin rather than aborting the whole round.
            await Promise.all(ALLOWED_CHAINS.map((coin) => this.loadOfferBook(coin, offersByCoin)));
            for(let desc of this.findMatches(offersByCoin)){
                try {
                    await this.finalizeMatch(desc);
                } catch(e){
                    logger.error(nodeUtil.format('CrossChainDex: finalizeMatch error:', e && e.message));
                }
            }
        } finally {
            this._matching = false;
        }
    },

    // One chain's confirmed open book into offersByCoin[coin], tagged with its home network.
    // A failed or network-less read yields an empty book for that chain, never a thrown tick.
    async loadOfferBook(coin, offersByCoin){
        if(!this.indexers[coin].url){ offersByCoin[coin] = []; return; }
        try {
            // Page the full open book via the keyset cursor rather than a one-shot
            // limit:500 (XCC-2): a chain holding >500 simultaneously-open cross-chain
            // offers would otherwise silently drop the newest, which are never discovered
            // or matched. fetchOpenOffers loops until the indexer reports the book is no
            // longer truncated (bounded by a hard page cap so a misbehaving indexer that
            // keeps flagging truncated can't spin forever).
            let res = await this.fetchOpenOffers(coin, { limit: 500 });
            // Tag every offer with its home indexer's network (authoritative). An offer
            // with no network (pre-network-scoping indexer) is unsafe to match, so we drop
            // the whole coin's book rather than risk a network-agnostic match.
            let net = res && res.network ? String(res.network) : '';
            let latest = Number(res && res.latest_block_index);
            // Enforce the confirmation-depth floor on the DISCOVERY/leader path too, not
            // only the follower's validateProposedMatch (findOpenOffer): the single-node
            // (quorum-0) fast path in CrossChainDexConsensus.propose self-signs + finalizes
            // WITHOUT ever calling the follower check, so without this gate XDEX_MIN_CONFIRMATIONS
            // is silently inert on a single operator and a match can settle against a
            // reorg-able escrow. Deep-enough = (latest - block_index + 1) >= the offer's
            // home-chain floor (per-coin defaults BTC 6 / LTC 12 / DOGE 60); an
            // offer with no resolvable depth is kept (an indexed order is >= 1 deep).
            let deepEnough = (o) => !(Number.isFinite(latest) && Number.isFinite(Number(o.block_index)) &&
                                      (latest - Number(o.block_index) + 1) < this.minConfirmations[coin]);
            offersByCoin[coin] = (res && res.orders && net)
                ? res.orders.filter(deepEnough).map(o => Object.assign({ home_coin: coin, home_network: net }, o))
                : [];
        } catch(e){
            offersByCoin[coin] = [];
        }
    },

    // Find compatible cross-chain matches. SWAP↔SWAP → exact full-amount fill (Phase A,
    // unchanged); ORDER↔ORDER → price-time book with partial fills (Phase B); SWAP↔ORDER
    // → skipped (carry-forward). Returns an array of match descriptors, each already
    // canonical-ordered (lo = home_coin-lower side). One fill per offer per round (`used`);
    // the poll loop drains deeper book crossings over subsequent rounds as committed grows.
    findMatches(offersByCoin){
        let all = [];
        for(let coin of ALLOWED_CHAINS) all = all.concat(offersByCoin[coin] || []);
        let matches = [], used = new Set();
        for(let i = 0; i < all.length; i++){
            let a = all[i], aKey = this.offerKey(a.home_coin, a.action_index);
            if(used.has(aKey)) continue;
            for(let j = i + 1; j < all.length; j++){
                let b = all[j], bKey = this.offerKey(b.home_coin, b.action_index);
                if(used.has(bKey)) continue;
                let desc = this.tryMatch(a, b);
                if(desc){
                    matches.push(desc);
                    used.add(aKey); used.add(bKey);
                    break;
                }
            }
        }
        return matches;
    },

    // Attempt to match offers a and b. Returns a canonical-ordered descriptor or null.
    tryMatch(a, b){
        if(a.home_coin === b.home_coin) return null;
        if((a.home_network || '') !== (b.home_network || '') || !a.home_network) return null; // never match across networks
        let aKind = (a.kind === 'order') ? 'order' : 'swap';
        let bKind = (b.kind === 'order') ? 'order' : 'swap';
        if(aKind === 'swap' && bKind === 'swap'){
            if(!this.isExactMatch(a, b)) return null;
            // Skip a swap already committed to a finalized match (it stays in the open book
            // until the indexer settles it). The committed ledger (not matchedOffers) is now
            // the reservation gate. Ownership offers expose amount '1' (see getOpenCrossChain*).
            if(bc.bclte(this.effectiveRemaining(a).give, 0) || bc.bclte(this.effectiveRemaining(b).give, 0)) return null;
            // Single full fill (committed is 0 pre-match → filled_before 0).
            return this.buildDesc(a, b, 'swap', 'swap', String(a.give_amount), String(b.give_amount));
        }
        if(aKind === 'order' && bKind === 'order') return this.tryOrderMatch(a, b);
        return null;                                   // SWAP↔ORDER: carry-forward
    },

    // Deterministic total order over offers for price-time priority (maker = earlier).
    // Reproducible by every node from the polled books: (block_index, home_coin, action_index).
    offerCmp(a, b){
        let ab = Number(a.block_index || 0), bb = Number(b.block_index || 0);
        if(ab !== bb) return ab < bb ? -1 : 1;
        if(a.home_coin !== b.home_coin) return a.home_coin < b.home_coin ? -1 : 1;
        let ai = Number(a.action_index), bi = Number(b.action_index);
        if(ai !== bi) return ai < bi ? -1 : 1;
        return 0;
    },

    // The structural and price-cross gates of an ORDER pair, then its maker and taker with
    // their limit prices and remaining capacity; null when the pair cannot fill.
    orderPricing(a, b){
        // Each side must give what the other wants (same token pair, mirrored ownership flags).
        if(a.give_coin !== b.get_coin || a.get_coin !== b.give_coin) return null;
        if((a.give_tick || '') !== (b.get_tick || '')) return null;
        if((a.get_tick  || '') !== (b.give_tick || '')) return null;
        if(Number(a.give_ownership || 0) !== Number(b.get_ownership || 0)) return null;
        if(Number(a.get_ownership  || 0) !== Number(b.give_ownership || 0)) return null;

        // Price-time priority: earlier = maker, later = taker (use the taker's limit prices
        // for the fill math, exactly as order_match.js uses the new order's prices).
        let maker, taker;
        if(this.offerCmp(a, b) <= 0){ maker = a; taker = b; } else { maker = b; taker = a; }

        let ownership = Number(a.give_ownership || 0) === 1 || Number(a.get_ownership || 0) === 1 ||
                        Number(b.give_ownership || 0) === 1 || Number(b.get_ownership || 0) === 1;

        // Limit prices from the FULL offer amounts (the ratio is fill-invariant).
        let takerGivePrice = bc.getPrice(taker.get_amount, taker.give_amount); // GET per GIVE (taker ask)
        let takerGetPrice  = bc.getPrice(taker.give_amount, taker.get_amount); // GIVE per GET
        let makerGetPrice  = bc.getPrice(maker.give_amount, maker.get_amount); // maker GIVE per maker GET (bid)
        // Skip price mismatch (order_match.js:118): maker's bid must reach the taker's ask.
        if(bc.bcgt(makerGetPrice, takerGivePrice)) return null;

        let takerRem = this.effectiveRemaining(taker);
        let makerRem = this.effectiveRemaining(maker);
        if(bc.bclte(takerRem.give, 0) || bc.bclte(makerRem.give, 0)) return null;
        if(bc.bclte(takerRem.get,  0) || bc.bclte(makerRem.get,  0)) return null;
        return { maker, taker, ownership, takerGivePrice, takerGetPrice, takerRem, makerRem };
    },

    quantizeFill(maker, taker, takerGive, takerGet){
        // Grid snap (gap CLOSED): the indexer follows the clamp with
        // bcround(amount, <that tick's DECIMALS>) on BOTH derived amounts
        // (order_match.js:219-220). That is what enforces indivisibility (a 0-decimal NFT
        // tick settles whole units) and clears sub-unit dust, so a hub that skipped it
        // could finalize a fill the settling indexer would never reproduce.
        //
        // Each amount is quantized on the grid of the leg that GIVES it, using the
        // decimals that leg's OWN home indexer reported for its OWN give tick
        // (getopencrosschainorders -> give_decimals, resolved there through the same
        // getTokenInfo the local matcher uses, so the two cannot drift):
        //   takerGive is denominated in taker.give_tick  -> taker's give_decimals
        //   takerGet  is denominated in maker.give_tick  -> maker's give_decimals
        // Deliberately never the counterparty's view of the same tick: a remote tick is
        // not in the reading indexer's token table at all, so only the home indexer is
        // authoritative for it. This is also exactly the amount each leg settles, so the
        // grid the hub rounds to is the grid the settling indexer will check.
        //
        // FAIL CLOSED when either side's decimals are absent or malformed: no match is
        // produced, and nothing is guessed. An 8-decimal COIN_DECIMALS default would
        // silently mis-quantize every 0-decimal (NFT) and non-8-decimal tick, which is
        // worse than not rounding at all, and a test pins that it is not done. The only
        // way to see missing decimals is a hub polling a pre-batch indexer, i.e. exactly
        // the half-deployed pair this package is documented to ship against: it stalls
        // matching (livelock) instead of settling a wrong quantity.
        let takerDecimals = this.giveDecimals(taker);
        let makerDecimals = this.giveDecimals(maker);
        if(takerDecimals === null || makerDecimals === null){
            logger.warn('XDEX: skipping match, missing give_decimals on ' +
                         (takerDecimals === null ? 'taker' : 'maker') + ' offer ' +
                         (takerDecimals === null ? taker.home_coin + ':' + taker.action_index
                                                 : maker.home_coin + ':' + maker.action_index) +
                         ' (indexer predates the decimals field?) - the hub will not guess tick decimals');
            return null;
        }
        takerGive = String(bc.bcround(takerGive, takerDecimals));
        takerGet  = String(bc.bcround(takerGet,  makerDecimals));
        // Zero-drop AFTER quantization, matching order_match.js's order (clamp, round,
        // then drop): dust that rounds to zero is not settled as a fill.
        if(bc.bclte(takerGive, 0) || bc.bclte(takerGet, 0)) return null;
        return { takerGive, takerGet };
    },

    // The decimal grid of an offer's GIVE side, or null when it cannot be established.
    //
    // The value is the offer's own home indexer's answer for its own tick, reported by
    // getopencrosschainorders as `give_decimals` and resolved there through getTokenInfo
    // (token DECIMALS, or that chain's COIN_DECIMALS for a native side) - the identical
    // resolution the local matcher performs, so the hub inherits it rather than
    // re-deriving it. The hub mirrors no token table and must never infer this: returning
    // null here makes the caller decline the match, which is why the range check is
    // strict rather than coercing. 0 is valid and meaningful (indivisible/NFT ticks), so
    // this must not be written as a falsy test; 18 is the protocol maximum.
    giveDecimals(offer){
        if(!offer) return null;
        let d = offer.give_decimals;
        if(d === null || d === undefined || d === '') return null;
        let n = Number(d);
        if(!Number.isInteger(n) || n < 0 || n > 18) return null;
        return n;
    },

    // Canonical-order a matched pair (lo = home_coin-lower side) into a finalize descriptor,
    // capturing each leg's pre-fill committed offset (binds the match_id + canonical).
    buildDesc(a, b, aKind, bKind, aGiveFill, bGiveFill){
        let lo, hi, loKind, hiKind, loFill, hiFill;
        if(a.home_coin <= b.home_coin){ lo = a; hi = b; loKind = aKind; hiKind = bKind; loFill = aGiveFill; hiFill = bGiveFill; }
        else                          { lo = b; hi = a; loKind = bKind; hiKind = aKind; loFill = bGiveFill; hiFill = aGiveFill; }
        return {
            lo, hi, loKind, hiKind,
            loFill: String(loFill), hiFill: String(hiFill),
            loFilledBefore: String(this.committedFor(lo).give),
            hiFilledBefore: String(this.committedFor(hi).give),
            network: a.home_network
        };
    },

    // True iff a and b are a clean cross-chain swap: each gives what the other wants.
    // Amounts compare by normalized decimal value (the two compared amounts are always the
    // SAME token, so same decimals). Not raw string: give_amount/get_amount are stored
    // VARCHAR as the user wrote them, so "100" and "100.00000000" are the same offer.
    isExactMatch(a, b){
        if(a.home_coin === b.home_coin) return false;
        if((a.home_network || '') !== (b.home_network || '') || !a.home_network) return false; // never match across networks

        if(a.give_coin !== b.get_coin || a.get_coin !== b.give_coin) return false;
        if((a.give_tick || '') !== (b.get_tick || '')) return false;
        if((a.get_tick || '') !== (b.give_tick || '')) return false;
        if(!this.amountsEqual(a.give_amount, b.get_amount)) return false;
        if(!this.amountsEqual(a.get_amount, b.give_amount)) return false;
        if(Number(a.give_ownership || 0) !== Number(b.get_ownership || 0)) return false;
        if(Number(a.get_ownership || 0)  !== Number(b.give_ownership || 0)) return false;
        return true;
    },

    // Canonicalize a validated, non-negative decimal numeral string for exact value compare:
    // strip insignificant leading (int) and trailing (fraction) zeros. Pure string math,
    // no float, no bignumber dep. It's exact at any precision and deterministic. null/empty
    // (ownership offers carry no amount) normalize to '' and compare equal to each other.
    normalizeAmount(v){
        if(v === null || v === undefined) return '';
        let s = String(v).trim();
        if(s === '') return '';
        let neg = s.startsWith('-');                  // pre-validated non-negative; defensive only
        if(neg) s = s.slice(1);
        let parts = s.split('.');
        let int  = (parts[0] || '').replace(/^0+/, '') || '0';
        let frac = (parts[1] || '').replace(/0+$/, '');
        let out  = frac ? (int + '.' + frac) : int;
        return (neg && out !== '0') ? '-' + out : out;
    },

    amountsEqual(x, y){
        return this.normalizeAmount(x) === this.normalizeAmount(y);
    },

    // Look up a single still-open cross-chain offer on `coin` by action_index, gated on
    // minConfirmations. Returns the offer (tagged like discoverAndMatch) or null.
    async findOpenOffer(coin, actionIndex){
        if(!this.indexers[coin] || !this.indexers[coin].url) return null;
        let res;
        // Page the full book (XCC-2): a one-shot limit:500 silently fails to re-confirm any
        // offer whose action_index sits past the cap, which would wrongly reject a valid match.
        try { res = await this.fetchOpenOffers(coin, { limit: 500 }); }
        catch(e){ return null; }
        if(!res || !Array.isArray(res.orders) || !res.network) return null;
        let latest = Number(res.latest_block_index);
        let o = res.orders.find(x => Number(x.action_index) === actionIndex);
        if(!o) return null;
        if(Number.isFinite(latest) && Number.isFinite(Number(o.block_index)) &&
           (latest - Number(o.block_index) + 1) < this.minConfirmations[coin]) return null;   // not deep enough
        return Object.assign({ home_coin: coin, home_network: String(res.network) }, o);
    },

    // Fetch a chain's ENTIRE open cross-chain book, paging the indexer's keyset cursor until
    // it reports the book is no longer truncated (XCC-2). Returns { network, latest_block_index,
    // orders } shaped like a single getopencrosschainorders response, with orders accumulated
    // across pages. network + latest_block_index are pinned to the FIRST page so the caller's
    // confirmation-depth floor uses one consistent tip across the whole book. Bounded by a hard
    // page cap (defense against an indexer that keeps flagging truncated without advancing) and
    // by requiring the cursor to strictly advance each page. Older indexers that don't return a
    // next_cursor fall back to the max action_index in the batch; ones that never set truncated
    // (pre-XCC-2) resolve in a single page, unchanged.
    async fetchOpenOffers(coin, opts){
        const MAX_PAGES = 40;                 // >= 20k offers at limit 500; a hard anti-spin bound
        let limit   = (opts && Number.isFinite(Number(opts.limit))) ? Number(opts.limit) : 500;
        let orders  = [];
        let network = '';
        let latest  = undefined;
        let after   = undefined;
        for(let page = 0; page < MAX_PAGES; page++){
            let params = { limit };
            if(after !== undefined) params.after_action_index = after;
            let res = await this.indexerCall(coin, 'getopencrosschainorders', params);
            if(!res) break;
            if(page === 0){
                network = res.network ? String(res.network) : '';
                latest  = res.latest_block_index;
            }
            let batch = Array.isArray(res.orders) ? res.orders : [];
            if(batch.length) orders = orders.concat(batch);
            if(res.truncated !== true) break;         // reached the tail of the book
            // Advance the keyset cursor: prefer the server-provided next_cursor, else the max
            // action_index in this batch. Stop if it can't strictly advance (empty batch or a
            // non-advancing/absent cursor) so a buggy indexer can never loop forever.
            let nextCursor = (res.next_cursor != null)
                ? Number(res.next_cursor)
                : batch.reduce((m, o) => Math.max(m, Number(o.action_index) || 0), Number.NEGATIVE_INFINITY);
            if(!Number.isFinite(nextCursor)) break;
            if(after !== undefined && nextCursor <= Number(after)) break;
            after = nextCursor;
        }
        return { network, latest_block_index: latest, orders };
    },
};
