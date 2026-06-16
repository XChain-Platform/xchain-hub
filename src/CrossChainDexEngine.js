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
 * XChain Hub - Cross-Chain DEX Engine
 *
 * Matches cross-chain ORDER/SWAP offers that NO single indexer can see (each
 * chain's order book lives in its own DB) and delivers the validated match to
 * every indexer through the existing hub-DB mirror — the same channel that
 * carries price_snapshots/oracle_prices. There is NO per-swap on-chain
 * settlement transaction: each indexer reads the finalized, validator-signed
 * match from its local mirror, verifies the 2f+1 `cross_chain` signatures, and
 * settles its leg straight from escrow (see the indexer's cross-chain
 * settlement pass).
 *
 * Flow:
 *   1. Discover — poll each chain's `getopencrosschainorders` RPC.
 *   2. Match    — pair compatible offers (Phase A: exact-match SWAP; FCFS).
 *   3. Finalize — federation reaches consensus (single-node bypasses P2P; multi-
 *                 node PBFT scaffolded), signs the canonical match (2f+1), writes
 *                 a `cross_chain_matches` row, and persists the `cross_chain`
 *                 capability snapshot at the round's BTC block so every indexer
 *                 can verify. The hub-DB broadcaster streams both rows to indexers.
 *   4. Retract  — on a source-order reorg, mark the match `retracted` and
 *                 broadcast a deletion so indexers roll back / skip it.
 *
 * Trust boundary: indexers verify the signatures, so a bad mirror can delay but
 * not forge a settlement. This is why the capability snapshot is propagated.
 *
 * Spec: claude/reports/2026-06-08_cross-chain-dex-mirror-settlement-design.md
 *       xchain-documentation/protocol/Cross_Chain_DEX.md
 *
 ********************************************************************/

const crypto       = require('crypto');
const EventEmitter = require('events');
const axios        = require('axios');

const bc                     = require('./bcmath.js');
const swq                    = require('./stake_weighted_quorum.js');
const eq                     = require('./equivocation_header.js');
const CrossChainDexConsensus = require('./CrossChainDexConsensus.js');

const ALLOWED_CHAINS = ['BTC', 'LTC', 'DOGE'];
const DEFAULT_POLL_MS = 15000;
// Min on-chain confirmations a give-side escrow must have before a peer will sign
// a proposed match (Byzantine safety against matching on a reorg-able escrow).
const DEFAULT_MIN_CONFIRMATIONS = 1;

class CrossChainDexEngine extends EventEmitter {

    constructor(hub){
        super();
        this.hub         = hub;
        this.db          = hub.db;
        this.peerManager = hub.getPeerManager ? hub.getPeerManager() : null;
        this.identity    = hub.getIdentity ? hub.getIdentity() : null;
        this.broadcaster  = hub.hubDbBroadcaster || null;
        this.capSnapshot  = hub.capabilitySnapshot || null;

        let cfg = hub.p2pConfig || {};
        this.pollMs = parseInt(process.env.XDEX_POLL_MS || cfg.XDEX_POLL_MS || DEFAULT_POLL_MS);

        // Regtest-only seams (OFF in prod). On a no-BTC regtest there is no BTC chain to
        // anchor the snapshot block or to source the cross_chain validator set from, so:
        //  - XDEX_SNAPSHOT_BLOCK supplies a fixed deterministic anchor, and
        //  - XDEX_SEED_LOCAL_VALIDATOR seeds capability_snapshots with this hub's own
        //    validator pubkey (single-node regtest = the only validator).
        // Both are inert unless explicitly set, so production (BTC-anchored) is unchanged.
        this._snapshotBlockOverride = parseInt(process.env.XDEX_SNAPSHOT_BLOCK || cfg.XDEX_SNAPSHOT_BLOCK);
        this._seedLocalValidator    = (process.env.XDEX_SEED_LOCAL_VALIDATOR === '1' ||
                                       cfg.XDEX_SEED_LOCAL_VALIDATOR === '1' || cfg.XDEX_SEED_LOCAL_VALIDATOR === true);

        // Per-coin indexer JSON-RPC endpoints for the matching view (federation read
        // methods need the api key): <COIN>_INDEXER_URL, <COIN>_INDEXER_API_KEY.
        this.indexers = {};
        for(let coin of ALLOWED_CHAINS){
            this.indexers[coin] = {
                url: process.env[coin + '_INDEXER_URL'] || cfg[coin + '_INDEXER_URL'] || '',
                key: process.env[coin + '_INDEXER_API_KEY'] || cfg[coin + '_INDEXER_API_KEY'] || ''
            };
        }

        // Per-offer committed-fill ledger, keyed `<chain>:<action_index>` →
        // { give, get } cumulative amounts already locked into finalized (non-retracted)
        // matches. The authoritative reservation source (Phase B): the hub derives an
        // offer's remaining capacity from this ledger — NOT from the indexer-reported
        // remaining, which lags until the indexer's settlement pass runs:
        //   effective_remaining(give) = full_give − committed.give
        // A SWAP commits its full amount in one fill (→ remaining 0, drops out, exactly
        // the Phase-A single-fill behavior); an ORDER accrues partial fills until full.
        // Rebuilt on startup from cross_chain_matches and kept in sync on finalize/retract.
        this.committed = new Map();

        // match_ids currently in a PBFT round but not yet written, so a fast next poll
        // doesn't re-propose the same deterministic fill. Cleared on write/failure;
        // _insertMatchRow is INSERT IGNORE so a slipped duplicate is still harmless.
        this._inflight = new Set();

        this.minConfirmations = parseInt(process.env.XDEX_MIN_CONFIRMATIONS || cfg.XDEX_MIN_CONFIRMATIONS || DEFAULT_MIN_CONFIRMATIONS);

        // PBFT consensus over each match. Single-node (quorum 0) collapses to an
        // immediate self-sign + finalize, so behavior with no federation is unchanged.
        this.consensus = new CrossChainDexConsensus(this);
        this.consensus.on('match:finalized', (ev) => {
            this._writeFinalizedMatch(ev).catch(err =>
                console.error('CrossChainDex: write finalized match error:', err && err.message));
        });

        this._pollTimer = null;
    }

    async start(){
        await this._rebuildCommitted();
        await this.consensus.start();           // subscribes to P2P; drives PBFT match rounds
        this._pollTimer = setInterval(() => {
            this._discoverAndMatch().catch(err => console.error('CrossChainDex: tick error:', err && err.message));
        }, this.pollMs);
        console.log('Cross-chain DEX engine started (poll ' + this.pollMs + 'ms)');
    }

    async stop(){
        if(this._pollTimer){ clearInterval(this._pollTimer); this._pollTimer = null; }
        await this.consensus.stop();
    }

    // Rebuild the committed-fill ledger from finalized matches (restart safety + the
    // authoritative reservation source). Each match contributes its fill amounts to BOTH
    // legs: A gives a_amount / receives b_amount, B gives b_amount / receives a_amount.
    async _rebuildCommitted(){
        this.committed.clear();
        try {
            let rows = await this.db.doQuery(
                "SELECT a_chain, a_action_index, a_amount, b_chain, b_action_index, b_amount " +
                "FROM cross_chain_matches WHERE status = 'finalized'");
            for(let r of rows) this._applyCommit(r, +1);
        } catch(e){ /* table may not exist yet */ }
    }

    // Offer ledger key.
    _offerKey(chain, actionIndex){ return chain + ':' + Number(actionIndex); }

    // Apply (sign=+1) or reverse (sign=-1) a match row's fills against both legs' ledgers.
    _applyCommit(r, sign){
        let kA = this._offerKey(r.a_chain, r.a_action_index);
        let kB = this._offerKey(r.b_chain, r.b_action_index);
        let a  = this.committed.get(kA) || { give: '0', get: '0' };
        let b  = this.committed.get(kB) || { give: '0', get: '0' };
        let aAmt = String(r.a_amount), bAmt = String(r.b_amount);
        let f = (sign < 0)
            ? (cur, amt) => String(bc.bcsub(cur, amt, 64))
            : (cur, amt) => String(bc.bcadd(cur, amt, 64));
        a.give = f(a.give, aAmt); a.get = f(a.get, bAmt);   // A gives a_amount, receives b_amount
        b.give = f(b.give, bAmt); b.get = f(b.get, aAmt);   // B gives b_amount, receives a_amount
        this.committed.set(kA, a);
        this.committed.set(kB, b);
    }

    // Committed { give, get } for an offer (default zero).
    _committedFor(offer){
        return this.committed.get(this._offerKey(offer.home_coin, offer.action_index)) || { give: '0', get: '0' };
    }

    // Remaining { give, get } capacity = full offer amount − committed (never below 0).
    // For a SWAP the "full" amount is the offer amount; once matched (committed == full)
    // both sides read 0 and it drops out of matching — the Phase-A single-fill behavior.
    _effectiveRemaining(offer){
        let c       = this._committedFor(offer);
        let fullGive = String(offer.give_amount != null ? offer.give_amount : '0');
        let fullGet  = String(offer.get_amount  != null ? offer.get_amount  : '0');
        let give = bc.bcsub(fullGive, c.give, 64);
        let get  = bc.bcsub(fullGet,  c.get,  64);
        return {
            give: bc.bclt(give, 0) ? '0' : String(give),
            get:  bc.bclt(get,  0) ? '0' : String(get),
            committedGive: c.give
        };
    }

    // ─── Discovery + matching ──────────────────────────────────────────────

    async _discoverAndMatch(){
        let offersByCoin = {};
        for(let coin of ALLOWED_CHAINS){
            if(!this.indexers[coin].url) continue;
            try {
                let res = await this._indexerCall(coin, 'getopencrosschainorders', { limit: 500 });
                // Tag every offer with its home indexer's network (authoritative). An offer
                // with no network (pre-network-scoping indexer) is unsafe to match, so we drop
                // the whole coin's book rather than risk a network-agnostic match.
                let net = res && res.network ? String(res.network) : '';
                offersByCoin[coin] = (res && res.orders && net)
                    ? res.orders.map(o => Object.assign({ home_coin: coin, home_network: net }, o))
                    : [];
            } catch(e){
                offersByCoin[coin] = [];
            }
        }
        for(let desc of this._findMatches(offersByCoin)){
            try {
                await this._finalizeMatch(desc);
            } catch(e){
                console.error('CrossChainDex: finalizeMatch error:', e && e.message);
            }
        }
    }

    // Find compatible cross-chain matches. SWAP↔SWAP → exact full-amount fill (Phase A,
    // unchanged); ORDER↔ORDER → price-time book with partial fills (Phase B); SWAP↔ORDER
    // → skipped (carry-forward). Returns an array of match descriptors, each already
    // canonical-ordered (lo = home_coin-lower side). One fill per offer per round (`used`);
    // the poll loop drains deeper book crossings over subsequent rounds as committed grows.
    _findMatches(offersByCoin){
        let all = [];
        for(let coin of ALLOWED_CHAINS) all = all.concat(offersByCoin[coin] || []);
        let matches = [], used = new Set();
        for(let i = 0; i < all.length; i++){
            let a = all[i], aKey = this._offerKey(a.home_coin, a.action_index);
            if(used.has(aKey)) continue;
            for(let j = i + 1; j < all.length; j++){
                let b = all[j], bKey = this._offerKey(b.home_coin, b.action_index);
                if(used.has(bKey)) continue;
                let desc = this._tryMatch(a, b);
                if(desc){
                    matches.push(desc);
                    used.add(aKey); used.add(bKey);
                    break;
                }
            }
        }
        return matches;
    }

    // Attempt to match offers a and b. Returns a canonical-ordered descriptor or null.
    _tryMatch(a, b){
        if(a.home_coin === b.home_coin) return null;
        if((a.home_network || '') !== (b.home_network || '') || !a.home_network) return null; // never match across networks
        let aKind = (a.kind === 'order') ? 'order' : 'swap';
        let bKind = (b.kind === 'order') ? 'order' : 'swap';
        if(aKind === 'swap' && bKind === 'swap'){
            if(!this._isExactMatch(a, b)) return null;
            // Skip a swap already committed to a finalized match (it stays in the open book
            // until the indexer settles it) — the committed ledger, not matchedOffers, is now
            // the reservation gate. Ownership offers expose amount '1' (see getOpenCrossChain*).
            if(bc.bclte(this._effectiveRemaining(a).give, 0) || bc.bclte(this._effectiveRemaining(b).give, 0)) return null;
            // Single full fill (committed is 0 pre-match → filled_before 0).
            return this._buildDesc(a, b, 'swap', 'swap', String(a.give_amount), String(b.give_amount));
        }
        if(aKind === 'order' && bKind === 'order') return this._tryOrderMatch(a, b);
        return null;                                   // SWAP↔ORDER: carry-forward
    }

    // Deterministic total order over offers for price-time priority (maker = earlier).
    // Reproducible by every node from the polled books: (block_index, home_coin, action_index).
    _offerCmp(a, b){
        let ab = Number(a.block_index || 0), bb = Number(b.block_index || 0);
        if(ab !== bb) return ab < bb ? -1 : 1;
        if(a.home_coin !== b.home_coin) return a.home_coin < b.home_coin ? -1 : 1;
        let ai = Number(a.action_index), bi = Number(b.action_index);
        if(ai !== bi) return ai < bi ? -1 : 1;
        return 0;
    }

    // ORDER↔ORDER book match with partial fills. Mirrors the indexer's local matcher
    // (xchain-indexer/src/actions/order_match.js): structural cross-compat, price-cross
    // gate, then the bottleneck clamp with orderInfo = taker (later) / matchInfo = maker
    // (earlier). Fill quantities are computed on effective_remaining (committed-aware), so
    // the same mirrored state always re-derives the same fill (PBFT determinism).
    _tryOrderMatch(a, b){
        // Each side must give what the other wants (same token pair, mirrored ownership flags).
        if(a.give_coin !== b.get_coin || a.get_coin !== b.give_coin) return null;
        if((a.give_tick || '') !== (b.get_tick || '')) return null;
        if((a.get_tick  || '') !== (b.give_tick || '')) return null;
        if(Number(a.give_ownership || 0) !== Number(b.get_ownership || 0)) return null;
        if(Number(a.get_ownership  || 0) !== Number(b.give_ownership || 0)) return null;

        // Price-time priority: earlier = maker, later = taker (use the taker's limit prices
        // for the fill math, exactly as order_match.js uses the new order's prices).
        let maker, taker;
        if(this._offerCmp(a, b) <= 0){ maker = a; taker = b; } else { maker = b; taker = a; }

        let ownership = Number(a.give_ownership || 0) === 1 || Number(a.get_ownership || 0) === 1 ||
                        Number(b.give_ownership || 0) === 1 || Number(b.get_ownership || 0) === 1;

        // Limit prices from the FULL offer amounts (the ratio is fill-invariant).
        let takerGivePrice = bc.getPrice(taker.get_amount, taker.give_amount); // GET per GIVE (taker ask)
        let takerGetPrice  = bc.getPrice(taker.give_amount, taker.get_amount); // GIVE per GET
        let makerGetPrice  = bc.getPrice(maker.give_amount, maker.get_amount); // maker GIVE per maker GET (bid)
        // Skip price mismatch (order_match.js:118): maker's bid must reach the taker's ask.
        if(bc.bcgt(makerGetPrice, takerGivePrice)) return null;

        let takerRem = this._effectiveRemaining(taker);
        let makerRem = this._effectiveRemaining(maker);
        if(bc.bclte(takerRem.give, 0) || bc.bclte(makerRem.give, 0)) return null;
        if(bc.bclte(takerRem.get,  0) || bc.bclte(makerRem.get,  0)) return null;

        // Bottleneck clamp (order_match.js:134-150), orderInfo = taker / matchInfo = maker.
        let max_give = bc.bclt(makerRem.get, takerRem.give) ? makerRem.get : takerRem.give;
        let max_get  = bc.bclt(makerRem.give, takerRem.get) ? makerRem.give : takerRem.get;
        let give_from_get = bc.bcmul(max_get, takerGetPrice, 18);
        let takerGive, takerGet;
        if(bc.bcgt(give_from_get, max_give)){
            takerGive = String(max_give);
            takerGet  = String(bc.bcmul(max_give, takerGivePrice, 18));
        } else {
            takerGive = String(give_from_get);
            takerGet  = String(max_get);
        }
        if(bc.bclte(takerGive, 0) || bc.bclte(takerGet, 0)) return null;

        if(ownership){
            // Ownership orders are single-fill exact (order_match.js:166-180): the fill must
            // equal the full canonical sides, no partials.
            let expGive = Number(taker.give_ownership || 0) === 1 ? '1' : String(taker.give_amount);
            let expGet  = Number(taker.get_ownership  || 0) === 1 ? '1' : String(taker.get_amount);
            if(!this._amountsEqual(takerGive, expGive) || !this._amountsEqual(takerGet, expGet)) return null;
        }

        // taker gives takerGive (its escrow); maker gives takerGet (== what the taker receives).
        let aGiveFill = (a === taker) ? takerGive : takerGet;
        let bGiveFill = (b === taker) ? takerGive : takerGet;
        return this._buildDesc(a, b, 'order', 'order', aGiveFill, bGiveFill);
    }

    // Canonical-order a matched pair (lo = home_coin-lower side) into a finalize descriptor,
    // capturing each leg's pre-fill committed offset (binds the match_id + canonical).
    _buildDesc(a, b, aKind, bKind, aGiveFill, bGiveFill){
        let lo, hi, loKind, hiKind, loFill, hiFill;
        if(a.home_coin <= b.home_coin){ lo = a; hi = b; loKind = aKind; hiKind = bKind; loFill = aGiveFill; hiFill = bGiveFill; }
        else                          { lo = b; hi = a; loKind = bKind; hiKind = aKind; loFill = bGiveFill; hiFill = aGiveFill; }
        return {
            lo, hi, loKind, hiKind,
            loFill: String(loFill), hiFill: String(hiFill),
            loFilledBefore: String(this._committedFor(lo).give),
            hiFilledBefore: String(this._committedFor(hi).give),
            network: a.home_network
        };
    }

    // True iff a and b are a clean cross-chain swap: each gives what the other wants.
    // Amounts compare by normalized decimal value (the two compared amounts are always the
    // SAME token, so same decimals), not raw string — give_amount/get_amount are stored
    // VARCHAR as the user wrote them, so "100" and "100.00000000" are the same offer.
    _isExactMatch(a, b){
        if(a.home_coin === b.home_coin) return false;
        if((a.home_network || '') !== (b.home_network || '') || !a.home_network) return false; // never match across networks

        if(a.give_coin !== b.get_coin || a.get_coin !== b.give_coin) return false;
        if((a.give_tick || '') !== (b.get_tick || '')) return false;
        if((a.get_tick || '') !== (b.give_tick || '')) return false;
        if(!this._amountsEqual(a.give_amount, b.get_amount)) return false;
        if(!this._amountsEqual(a.get_amount, b.give_amount)) return false;
        if(Number(a.give_ownership || 0) !== Number(b.get_ownership || 0)) return false;
        if(Number(a.get_ownership || 0)  !== Number(b.give_ownership || 0)) return false;
        return true;
    }

    // Canonicalize a validated, non-negative decimal numeral string for exact value compare:
    // strip insignificant leading (int) and trailing (fraction) zeros. Pure string math — no
    // float, no bignumber dep — so it's exact at any precision and deterministic. null/empty
    // (ownership offers carry no amount) normalize to '' and compare equal to each other.
    _normalizeAmount(v){
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
    }

    _amountsEqual(x, y){
        return this._normalizeAmount(x) === this._normalizeAmount(y);
    }

    // ─── Finalize: sign + write the match row + persist the capability snapshot ──

    async _finalizeMatch(desc){
        let snapshotBlock = await this._resolveSnapshotBlock();
        if(snapshotBlock == null) throw new Error('cannot resolve snapshot block');

        let lo = desc.lo, hi = desc.hi;
        let matchId       = this._deriveMatchId(lo, hi, snapshotBlock, desc.loFilledBefore, desc.hiFilledBefore);
        if(this._inflight.has(matchId)) return;        // already in a round this poll
        let effectiveTime = this._nowSeconds();

        // lo = canonical-lower. On lo's chain, lo's escrow releases to hi's payout
        // (hi.get_address, hi's receive addr on lo's chain). On hi's chain, hi's escrow
        // releases to lo's payout. a_amount/b_amount = the FILL settled by THIS match.
        let row = {
            match_id:        matchId,
            snapshot_block:  Number(snapshotBlock),
            network:         desc.network,             // lo.home_network == hi.home_network (enforced in _tryMatch)
            a_chain:         lo.home_coin,
            a_action_index:  Number(lo.action_index),
            a_kind:          desc.loKind,
            a_tick:          lo.give_tick || null,
            a_amount:        String(desc.loFill),
            a_filled_before: String(desc.loFilledBefore),
            a_ownership:     Number(lo.give_ownership || 0),
            a_payout_addr:   lo.get_address,           // A receives on hi's chain
            b_chain:         hi.home_coin,
            b_action_index:  Number(hi.action_index),
            b_kind:          desc.hiKind,
            b_tick:          hi.give_tick || null,
            b_amount:        String(desc.hiFill),
            b_filled_before: String(desc.hiFilledBefore),
            b_ownership:     Number(hi.give_ownership || 0),
            b_payout_addr:   hi.get_address,           // B receives on lo's chain
            effective_time:  effectiveTime
        };

        // Resolve the cross_chain validator set at snapshot_block (deterministic,
        // BTC-anchored) so every node computes the same quorum. The leader of the
        // round persists + mirrors these rows to indexers (in consensus PROPOSE).
        let validators = await this._resolveCapabilityValidators('cross_chain', Number(snapshotBlock), row.network);

        // Reserve this fill in-flight so a later poll doesn't re-propose it before the
        // committed ledger is updated by _writeFinalizedMatch.
        this._inflight.add(matchId);
        try {
            // Run the PBFT round. quorum 0 (single operator) self-signs + finalizes inline;
            // a federation gathers 2f+1 independent signatures, then 'match:finalized' fires
            // and _writeFinalizedMatch writes + mirrors the row.
            await this.consensus.propose(matchId, { row: row, snapshot: { validators: validators, count: validators.length } });
        } catch(e){
            this._inflight.delete(matchId);            // round failed to start — allow a retry
            throw e;
        }
    }

    // Persist a consensus-finalized match (2f+1 signatures attached) and mirror it. Update
    // the committed ledger only when the row is actually inserted (INSERT IGNORE), so a
    // duplicate finalize (another hub / restart race) never double-counts a fill.
    async _writeFinalizedMatch(ev){
        let row = ev.row;
        row.validator_signatures = JSON.stringify(ev.signatures || []);
        row.finalizing_view = ev.view != null ? ev.view : 0;   // PBFT view at finalization; signed into the EQUIV canonical (WI-2 bump 2)
        // EVERY hub persists the capability snapshot for the row's snapshot_block,
        // not just the round leader: the indexers verify the row's signatures
        // against capability_snapshots in whichever hub DB they mirror, and a
        // follower's DB may be the only one they read. Deterministic from BTC
        // stakes + idempotent (INSERT IGNORE), so all hubs write identical rows.
        try { await this._persistCapabilitySnapshot('cross_chain', Number(row.snapshot_block), row.network); }
        catch(e){ console.warn('CrossChainDex: snapshot persist on finalize failed: ' + (e && e.message)); }
        let inserted = await this._insertMatchRow(row);
        if(inserted) this._applyCommit(row, +1);
        this._inflight.delete(row.match_id);
        console.log('CrossChainDex: finalized ' + String(row.match_id).substring(0, 16) + '... ' +
                    row.a_chain + ':' + row.a_action_index + ' ⇄ ' + row.b_chain + ':' + row.b_action_index +
                    ' [' + row.a_kind + '/' + row.b_kind + '] fill ' + row.a_amount + '⇄' + row.b_amount +
                    ' (' + (ev.signatures ? ev.signatures.length : 0) + ' sigs)');
        this.emit('match:finalized', { matchId: row.match_id });
    }

    // Independent confirmation a peer runs before signing a leader's proposed match:
    // re-fetch both chains' open cross-chain orders, confirm each leg is still open +
    // escrowed + at least minConfirmations deep, and that the pair re-derives to the
    // SAME match_id and canonical. Returns true only when our own view confirms the
    // match — a Byzantine leader cannot get us to sign a match we can't independently see.
    async validateProposedMatch(row){
        if(!row || row.a_chain === row.b_chain) return false;
        let a = await this._findOpenOffer(row.a_chain, Number(row.a_action_index));
        let b = await this._findOpenOffer(row.b_chain, Number(row.b_action_index));
        if(!a || !b) return false;
        if((a.home_network || '') !== String(row.network || '')) return false;
        if((b.home_network || '') !== String(row.network || '')) return false;
        // Re-derive the WHOLE match (kind, fill amounts, filled-before offsets, match_id)
        // independently from our own view — offers + our committed ledger. The proposer's
        // a/b are canonical (a_chain <= b_chain), so _tryMatch(a, b) keeps lo=a, hi=b.
        let desc = this._tryMatch(a, b);
        if(!desc) return false;
        if(desc.loKind !== row.a_kind || desc.hiKind !== row.b_kind) return false;
        if(!this._amountsEqual(desc.loFill, row.a_amount) || !this._amountsEqual(desc.hiFill, row.b_amount)) return false;
        if(!this._amountsEqual(desc.loFilledBefore, row.a_filled_before) ||
           !this._amountsEqual(desc.hiFilledBefore, row.b_filled_before)) return false;
        let derivedId = this._deriveMatchId(desc.lo, desc.hi, Number(row.snapshot_block), desc.loFilledBefore, desc.hiFilledBefore);
        if(String(derivedId).toLowerCase() !== String(row.match_id).toLowerCase()) return false;
        return true;
    }

    // Look up a single still-open cross-chain offer on `coin` by action_index, gated on
    // minConfirmations. Returns the offer (tagged like _discoverAndMatch) or null.
    async _findOpenOffer(coin, actionIndex){
        if(!this.indexers[coin] || !this.indexers[coin].url) return null;
        let res;
        try { res = await this._indexerCall(coin, 'getopencrosschainorders', { limit: 500 }); }
        catch(e){ return null; }
        if(!res || !Array.isArray(res.orders) || !res.network) return null;
        let latest = Number(res.latest_block_index);
        let o = res.orders.find(x => Number(x.action_index) === actionIndex);
        if(!o) return null;
        if(Number.isFinite(latest) && Number.isFinite(Number(o.block_index)) &&
           (latest - Number(o.block_index) + 1) < this.minConfirmations) return null;   // not deep enough
        return Object.assign({ home_coin: coin, home_network: String(res.network) }, o);
    }

    // Canonical signing string. MUST byte-match the indexer's verifier (the
    // cross-chain settlement pass rebuilds this from the mirrored row).
    // Canonical signing string. MUST byte-match the indexer's verifier (the cross-chain
    // settlement pass rebuilds this from the mirrored row). Phase B appends the fill fields
    // after `network` so the Phase-A field order is preserved. a_amount/b_amount carry the
    // FILL settled by this match; *_kind + *_filled_before disambiguate sequential fills.
    // `view` = the PBFT view this signature is taken at (the consensus passes the live
    // pending.view; the indexer/archive twins pass the persisted finalizing_view). At/above
    // the EQUIV flag-day the XMATCH content is wrapped in the uniform header (TAG=XDEX,
    // ROUND_ID=match_id, VIEW=view) — putting <view> in the signed bytes is what lets a
    // legitimate view change (re-sign at a higher view) be told apart from equivocation.
    // The view is NOT a content field; it lives only in the header.
    _canonicalMatch(r, view){
        let raw = [
            'XMATCH', r.match_id, String(r.snapshot_block),
            r.a_chain, String(r.a_action_index), r.a_tick || '', String(r.a_amount), String(r.a_ownership), r.a_payout_addr,
            r.b_chain, String(r.b_action_index), r.b_tick || '', String(r.b_amount), String(r.b_ownership), r.b_payout_addr,
            String(r.effective_time), r.network || '',
            r.a_kind || 'swap', String(r.a_filled_before != null ? r.a_filled_before : '0'),
            r.b_kind || 'swap', String(r.b_filled_before != null ? r.b_filled_before : '0')
        ].join('|');
        if(eq.isEquivHeaderActive(r.snapshot_block, r.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, r.match_id, (view != null ? view : 0), raw);
        return raw;
    }

    // Returns true iff the row was actually inserted (false on INSERT IGNORE dedupe), so the
    // caller only updates the committed ledger once per fill.
    async _insertMatchRow(row){
        let cols = ['match_id','snapshot_block','network',
                    'a_chain','a_action_index','a_kind','a_tick','a_amount','a_filled_before','a_ownership','a_payout_addr',
                    'b_chain','b_action_index','b_kind','b_tick','b_amount','b_filled_before','b_ownership','b_payout_addr',
                    'effective_time','finalizing_view','validator_signatures'];
        let vals = cols.map(c => row[c]);
        // INSERT IGNORE — match_id is unique, so a re-finalize (e.g. another hub or a
        // restart racing the poll) is a harmless no-op.
        let res = await this.db.doQuery(
            'INSERT IGNORE INTO cross_chain_matches (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')',
            vals);
        let inserted = !!(res && Number(res.affectedRows) > 0);
        // Mirror to indexers: re-read the row (to get its AUTO_INCREMENT id) and broadcast.
        if(this.broadcaster){
            let read = await this.db.doQuery('SELECT * FROM cross_chain_matches WHERE match_id = ? LIMIT 1', [row.match_id]);
            if(read.length) this.broadcaster.broadcastRow({ table: 'cross_chain_matches', row: read[0] });
        }
        return inserted;
    }

    // Resolve the qualifying validator set for `capability` at `block` from the
    // BTC indexer via CapabilitySnapshot (on-chain-deterministic), with the regtest
    // seam fallback (XDEX_SEED_LOCAL_VALIDATOR → this hub's own pubkey). Used for both
    // quorum (in _finalizeMatch) and the mirror persist (_persistCapabilitySnapshot).
    // Resolve the qualifying validator set, normalized to { pubkey, source, weight, amount }.
    // At/above STAKE_WEIGHTED_QUORUM activation (keyed on the BTC snapshot_block +
    // network) this fetches the SOURCE-KEYED weights; below it, the legacy count set
    // (source='' , weight=amount) — byte-for-byte the old membership/values, so the
    // pre-activation path and mirror rows are unchanged.
    async _resolveCapabilityValidators(capability, block, network){
        let validators = [];
        let weighted = swq.isStakeWeightedQuorumActive(block, network);
        if(this.capSnapshot){
            if(weighted){
                let snap = await this.capSnapshot.getWeightSnapshot(capability, block);
                if(snap && Array.isArray(snap.validators))
                    validators = snap.validators.map(v => ({ pubkey: v.pubkey, source: String(v.source != null ? v.source : ''), weight: String(v.weight != null ? v.weight : '0'), amount: String(v.weight != null ? v.weight : '0') }));
            } else {
                let snap = await this.capSnapshot.getSnapshot(capability, block);
                if(snap && Array.isArray(snap.validators))
                    validators = snap.validators.map(v => ({ pubkey: v.pubkey, source: '', weight: String(v.amount != null ? v.amount : '0'), amount: String(v.amount != null ? v.amount : '0') }));
            }
        }
        if(validators.length === 0 && this._seedLocalValidator && this.identity){
            let pk = this.identity.getPubkeyHex();
            // Synthetic single-source seed: weight 1 trivially clears 3·1 > 2·1.
            validators = [{ pubkey: pk, source: 'seed:' + String(pk).toLowerCase(), weight: '1', amount: '1' }];
        }
        return validators;
    }

    // Persist the qualifying validator set for `capability` at `block` to
    // capability_snapshots (idempotent), and mirror each row to indexers. Writes the
    // source-keyed weight (amount column) + the source discriminator so non-BTC
    // indexers + recovery can dedupe quorum weight by staking address.
    async _persistCapabilitySnapshot(capability, block, network){
        let validators = await this._resolveCapabilityValidators(capability, block, network);
        for(let v of validators){
            let pubkey = String(v.pubkey).toLowerCase();
            let amount = String(v.weight != null ? v.weight : (v.amount != null ? v.amount : '0'));
            let source = String(v.source != null ? v.source : '');
            await this.db.doQuery(
                'INSERT IGNORE INTO capability_snapshots (snapshot_block, capability, signing_pubkey, amount, source) VALUES (?, ?, ?, ?, ?)',
                [block, capability, pubkey, amount, source]);
            if(this.broadcaster){
                let r = await this.db.doQuery(
                    'SELECT * FROM capability_snapshots WHERE snapshot_block = ? AND capability = ? AND signing_pubkey = ? LIMIT 1',
                    [block, capability, pubkey]);
                if(r.length) this.broadcaster.broadcastRow({ table: 'capability_snapshots', row: r[0] });
            }
        }
    }

    // ─── Retraction (reorg) ────────────────────────────────────────────────

    // Mark matches referencing a rolled-back source order as retracted and broadcast a
    // deletion so indexers skip / roll back. Called by reorg handling.
    async retractMatchesForReorg(chain, fromActionIndex){
        let rows = await this.db.doQuery(
            "SELECT match_id, a_chain, a_action_index, a_amount, b_chain, b_action_index, b_amount FROM cross_chain_matches " +
            "WHERE status = 'finalized' AND ((a_chain = ? AND a_action_index >= ?) OR (b_chain = ? AND b_action_index >= ?))",
            [chain, fromActionIndex, chain, fromActionIndex]);
        for(let r of rows){
            await this.db.doQuery("UPDATE cross_chain_matches SET status = 'retracted' WHERE match_id = ?", [r.match_id]);
            this._applyCommit(r, -1);                   // restore both legs' remaining capacity
            this._inflight.delete(r.match_id);
            if(this.broadcaster)
                this.broadcaster.broadcastDeletion({ table: 'cross_chain_matches', source_chain: chain, from_action_index: fromActionIndex });
        }
    }

    // ─── Helpers ───────────────────────────────────────────────────────────

    async _indexerCall(coin, method, params){
        let ix = this.indexers[coin];
        if(!ix || !ix.url) throw new Error('no indexer url for ' + coin);
        let headers = { 'Content-Type': 'application/json' };
        if(ix.key) headers['x-api-key'] = ix.key;
        let resp = await axios.post(ix.url, { jsonrpc: '2.0', method, params: params || {}, id: 1 }, { headers, timeout: 15000 });
        if(resp.data && resp.data.error) throw new Error('indexer RPC error: ' + JSON.stringify(resp.data.error));
        return resp.data ? resp.data.result : null;
    }

    // Deterministic match identifier (sha256 hex; satisfies the indexer's
    // /^[0-9a-zA-Z_-]{1,80}$/ MATCH_ID rule). lo/hi are already canonical-ordered (lo =
    // home_coin-lower). Binds network + both offer refs + snapshot block + each leg's
    // cumulative-filled-before offset, so two sequential partial fills of the SAME order
    // pair at the SAME snapshot_block produce DISTINCT ids (offsets normalized so
    // "0" == "0.00000000").
    _deriveMatchId(lo, hi, snapshotBlock, loFilledBefore, hiFilledBefore){
        let s = (lo.home_network || '') +
                '|' + lo.home_coin + ':' + lo.action_index + ':' + this._normalizeAmount(loFilledBefore) +
                '|' + hi.home_coin + ':' + hi.action_index + ':' + this._normalizeAmount(hiFilledBefore) +
                '|' + snapshotBlock;
        return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
    }

    _nowSeconds(){ return Math.floor(Date.now() / 1000); }

    // Resolve the BTC-anchored snapshot block. In a no-BTC regtest, fall back to a fixed
    // deterministic override (XDEX_SNAPSHOT_BLOCK) so the match + capability snapshot share
    // a consistent anchor. Production always resolves the live BTC tip (override unset).
    async _resolveSnapshotBlock(){
        let b = this.hub._resolveBtcLatestBlock ? await this.hub._resolveBtcLatestBlock() : null;
        if(b != null) return b;
        return Number.isFinite(this._snapshotBlockOverride) ? this._snapshotBlockOverride : null;
    }

}

module.exports = CrossChainDexEngine;
