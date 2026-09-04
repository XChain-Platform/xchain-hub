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
 * every indexer through the existing hub-DB mirror (the same channel that
 * carries price_snapshots/oracle_prices. There is NO per-swap on-chain
 * settlement transaction: each indexer reads the finalized, validator-signed
 * match from its local mirror, verifies the 2f+1 `cross_chain` signatures, and
 * settles its leg straight from escrow (see the indexer's cross-chain
 * settlement pass).
 *
 * Flow:
 *   1. Discover: poll each chain's `getopencrosschainorders` RPC.
 *   2. Match: pair compatible offers (Phase A: exact-match SWAP; FCFS).
 *   3. Finalize: federation reaches consensus (single-node bypasses P2P; multi-
 *                 node PBFT scaffolded), signs the canonical match (2f+1), writes
 *                 a `cross_chain_matches` row, and persists the `cross_chain`
 *                 capability snapshot at the round's BTC block so every indexer
 *                 can verify. The hub-DB broadcaster streams both rows to indexers.
 *   4. Retract: on a source-order reorg, mark the match `retracted` and
 *                 broadcast a deletion so indexers roll back / skip it.
 *
 * Trust boundary: indexers verify the signatures, so a bad mirror can delay but
 * not forge a settlement. This is why the capability snapshot is propagated.
 *
 * Spec: xchain-documentation/protocol/Cross_Chain_DEX.md
 *
 ********************************************************************/

const crypto       = require('crypto');
const EventEmitter = require('events');
const axios        = require('axios');

const bc                     = require('./bcmath.js');
const swq                    = require('./stake_weighted_quorum.js');
const eq                     = require('./equivocation_header.js');
const ccr                    = require('./cross_chain_royalty_activation.js');
const CrossChainDexConsensus = require('./CrossChainDexConsensus.js');
const { normalizeRetractionBounds } = require('./lib/retraction_bounds.js');
const { RELAY_MIN_FUTURE_S, relayMarginFloorS } = require('./lib/relay_margin.js');
const { allCanonicalInts }   = require('./lib/canonical_int.js');
const snapWrite              = require('./lib/capability_snapshot_write.js');
const coins                  = require('./coins');

// The INT-backed fields _canonicalMatch signs VERBATIM while the indexer's
// settlement pass rebuilds them from the mirrored BIGINT row. The fill and
// filled-before fields are bcmath DECIMAL strings compared through _amountsEqual,
// and ticks / addresses / kinds / payout legs are string compares, so none of them
// belong here.
const DEX_CANONICAL_INT_FIELDS = ['snapshot_block', 'a_action_index', 'b_action_index',
                                  'a_ownership', 'b_ownership', 'effective_time'];

const ALLOWED_CHAINS = [...coins.ALLOWED_COINS];
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
        // Honored ONLY on regtest; NaN/false everywhere else (fail closed to the real
        // set) so a stray env var or configs-table row never reaches the SIGNED snapshot
        // anchor or the seeded validator on mainnet/testnet. Mirrors StateCheckpointEngine.
        this.network = (hub && hub.network) ? hub.network : '';
        let _isRegtest = (this.network === 'regtest');
        this._snapshotBlockOverride = _isRegtest ? parseInt(process.env.XDEX_SNAPSHOT_BLOCK || cfg.XDEX_SNAPSHOT_BLOCK) : NaN;
        this._seedLocalValidator    = _isRegtest && (process.env.XDEX_SEED_LOCAL_VALIDATOR === '1' ||
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
        // offer's remaining capacity from this ledger, not from the indexer-reported
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

        // Per-coin confirmation-depth floor for a give-side escrow (XDEX-CONF-1).
        // A 1-conf escrow that reorgs after the counter-leg settled on the other chain is
        // a cross-chain value loss, worst on DOGE; the sibling CrossChainCallEngine already
        // uses the per-chain defaults (BTC 6 / LTC 12 / DOGE 60) for the identical concern.
        // Precedence per coin: XDEX_MIN_CONFIRMATIONS_<COIN> > flat XDEX_MIN_CONFIRMATIONS
        // (legacy knob, e.g. regtest venues pinning 1) > coins.DEFAULT_CONFIRMATIONS[coin].
        // A signing gate only, not signed content: no canonical/flag-day impact.
        let flatMinConf = parseInt(process.env.XDEX_MIN_CONFIRMATIONS || cfg.XDEX_MIN_CONFIRMATIONS);
        // Clamp an override back up to the per-coin default on mainnet and testnet, the
        // same raise-only rule coins.resolveConfirmations enforces for XCHAIN_CONFIRMATIONS_<COIN>
        // (CF-1): a lowered depth here lets this hub co-sign a match against an escrow the rest
        // of the federation still treats as reorg-able. Regtest keeps the full override.
        let _confFloored = (this.network === 'mainnet' || this.network === 'testnet');
        this.minConfirmations = {};
        for(const tick of ALLOWED_CHAINS){
            let perCoin = parseInt(process.env['XDEX_MIN_CONFIRMATIONS_' + tick] || cfg['XDEX_MIN_CONFIRMATIONS_' + tick]);
            let def = coins.DEFAULT_CONFIRMATIONS[tick] || DEFAULT_MIN_CONFIRMATIONS;
            let val = Number.isFinite(perCoin) && perCoin > 0 ? perCoin
                    : (Number.isFinite(flatMinConf) && flatMinConf > 0 ? flatMinConf
                    : def);
            if(_confFloored && val < def){
                console.warn('[CrossChainDex] XDEX_MIN_CONFIRMATIONS' + (Number.isFinite(perCoin) && perCoin > 0 ? '_' + tick : '') +
                    '=' + val + ' is below the ' + this.network + ' floor ' + def + '; clamping to ' + def +
                    ' (confirmation overrides may only raise the depth on mainnet and testnet; ' +
                    'regtest keeps the full override)');
                val = def;
            }
            this.minConfirmations[tick] = val;
        }

        // PBFT consensus over each match. Single-node (quorum 0) collapses to an
        // immediate self-sign + finalize, so behavior with no federation is unchanged.
        this.consensus = new CrossChainDexConsensus(this);
        this.consensus.on('match:finalized', (ev) => {
            this._writeFinalizedMatch(ev).catch(err =>
                console.error('CrossChainDex: write finalized match error:', err && err.message));
        });
        // Release the inflight slot for a round the consensus abandons (stale under
        // sustained message loss) so the next poll re-proposes it instead of the
        // match wedging permanently. Mirrors CrossChainCallEngine.
        this.consensus.on('match:abandoned', (ev) => {
            this._inflight.delete(String(ev.matchId));
        });

        this._pollTimer = null;
        this._matching  = false;   // poll self-overlap guard, see _discoverAndMatch()
    }

    async start(){
        // Fill any indexer URL left empty at construction (configs-table-
        // provisioned hubs carry no *_INDEXER_URL env var) via the hub's
        // configs-aware resolver, then warn loudly for any chain still missing,
        // so this engine cannot silently match nothing forever.
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
                console.warn('CrossChainDex: no indexer URL for chain ' + coin + ' (set ' + coin + '_INDEXER_API_URL / ' + coin + '_INDEXER_URL, or push it via xchain-node updateconfig); this chain is skipped every tick until configured');
        }
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

    _committedFor(offer){
        return this.committed.get(this._offerKey(offer.home_coin, offer.action_index)) || { give: '0', get: '0' };
    }

    // Remaining { give, get } capacity = full offer amount − committed (never below 0).
    // For a SWAP the "full" amount is the offer amount; once matched (committed == full)
    // both sides read 0 and it drops out of matching (the Phase-A single-fill behavior).
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

    async _discoverAndMatch(){
        // Poll self-overlap guard (house convention: FullNodeChallengeRound._tick,
        // AttestationRound._pollPending). The poll is a bare setInterval at 15s while one
        // pass makes three paged indexer round trips plus a PBFT round and its DB writes,
        // so a slow indexer lets the next interval fire on top of this one. Two overlapping
        // passes read the SAME order books and the same this.committed ledger (which only
        // advances in _writeFinalizedMatch, after consensus), so both derive the same fills;
        // the _inflight matchId reservation does not stop them, because the has() test in
        // _finalizeMatch sits two awaits before the matching add(), and a snapshot block
        // that moved between the passes gives the second one a DIFFERENT matchId for the
        // same offers anyway. Result: the same offer proposed into two PBFT rounds and
        // double-committed against a single escrow. The finally is load-bearing: a rejected
        // _fetchOpenOffers or _resolveSnapshotBlock must not wedge matching forever.
        if(this._matching) return;
        this._matching = true;
        try {
            let offersByCoin = {};
            // Fetch each coin's order book in parallel: the three RPC calls are fully
            // independent (each populates its own offersByCoin slot) and matching runs
            // only after all books are collected, so parallelising cuts ~2x per-coin
            // latency from every poll tick without changing which offers are matched or
            // in what order. Per-coin try/catch is preserved so one slow/failed indexer
            // still yields an empty book for that coin rather than aborting the whole round.
            await Promise.all(ALLOWED_CHAINS.map(async (coin) => {
                if(!this.indexers[coin].url){ offersByCoin[coin] = []; return; }
                try {
                    // Page the full open book via the keyset cursor rather than a one-shot
                    // limit:500 (XCC-2): a chain holding >500 simultaneously-open cross-chain
                    // offers would otherwise silently drop the newest, which are never discovered
                    // or matched. _fetchOpenOffers loops until the indexer reports the book is no
                    // longer truncated (bounded by a hard page cap so a misbehaving indexer that
                    // keeps flagging truncated can't spin forever).
                    let res = await this._fetchOpenOffers(coin, { limit: 500 });
                    // Tag every offer with its home indexer's network (authoritative). An offer
                    // with no network (pre-network-scoping indexer) is unsafe to match, so we drop
                    // the whole coin's book rather than risk a network-agnostic match.
                    let net = res && res.network ? String(res.network) : '';
                    let latest = Number(res && res.latest_block_index);
                    // Enforce the confirmation-depth floor on the DISCOVERY/leader path too, not
                    // only the follower's validateProposedMatch (_findOpenOffer): the single-node
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
            }));
            for(let desc of this._findMatches(offersByCoin)){
                try {
                    await this._finalizeMatch(desc);
                } catch(e){
                    console.error('CrossChainDex: finalizeMatch error:', e && e.message);
                }
            }
        } finally {
            this._matching = false;
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
            // until the indexer settles it). The committed ledger (not matchedOffers) is now
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
        // PRECISION 64, matching order_match.js:197/202 exactly.
        //
        // These two multiplications ran at precision 18 while the indexer's identical
        // bottleneck-clamp derivation runs at the mathjs default 64, and getPrice above
        // already produces a 64-digit rate. Truncating the product to 18 places threw
        // away digits the indexer keeps, so for a price that is not exactly
        // representable the hub and the indexer derived DIFFERENT fill quantities from
        // the same pair of offers. This file's bcmath header states the two must be
        // byte-equivalent; at 18 they were not, and a hub that finalizes a fill the
        // indexer will not reproduce is the livelock the finding pair documents.
        let give_from_get = bc.bcmul(max_get, takerGetPrice, 64);
        let takerGive, takerGet;
        if(bc.bcgt(give_from_get, max_give)){
            takerGive = String(max_give);
            takerGet  = String(bc.bcmul(max_give, takerGivePrice, 64));
        } else {
            takerGive = String(give_from_get);
            takerGet  = String(max_get);
        }
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
        let takerDecimals = this._giveDecimals(taker);
        let makerDecimals = this._giveDecimals(maker);
        if(takerDecimals === null || makerDecimals === null){
            console.warn('XDEX: skipping match, missing give_decimals on ' +
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
    _giveDecimals(offer){
        if(!offer) return null;
        let d = offer.give_decimals;
        if(d === null || d === undefined || d === '') return null;
        let n = Number(d);
        if(!Number.isInteger(n) || n < 0 || n > 18) return null;
        return n;
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
    // SAME token, so same decimals). Not raw string: give_amount/get_amount are stored
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
    // strip insignificant leading (int) and trailing (fraction) zeros. Pure string math,
    // no float, no bignumber dep. It's exact at any precision and deterministic. null/empty
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

    async _finalizeMatch(desc){
        let snapshotBlock = await this._resolveSnapshotBlock();
        if(snapshotBlock == null) throw new Error('cannot resolve snapshot block');

        let lo = desc.lo, hi = desc.hi;
        let matchId       = this._deriveMatchId(lo, hi, snapshotBlock, desc.loFilledBefore, desc.hiFilledBefore);
        if(this._inflight.has(matchId)) return;        // already in a round this poll
        // Forward propagation margin (#4202). A match settles on BOTH legs at the
        // first block whose block_time reaches effective_time, so stamping the bare
        // clock second made the match eligible the instant it finalized: an indexer
        // that already held the mirrored row settled a block earlier than one still
        // receiving it, and the two then carried different settlement action indexes
        // for the same match. Size the margin to the SLOWER of the two legs, since
        // both chains must hold the row before either reaches its eligible block.
        let effectiveTime = this._nowSeconds() +
            Math.max(relayMarginFloorS(lo.home_coin), relayMarginFloorS(hi.home_coin));

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
            // Controller-guard royalty split of each order's proceeds (JSON [{to,bps}] in the
            // order's OWN chain encoding, or null). Copied verbatim from the source indexer's
            // open-order feed; the proceeds chain re-encodes + applies it at cross_settle. At/
            // above the CROSS_CHAIN_ROYALTY flag-day the legs are part of the signed canonical.
            a_payout_legs:   lo.payout_legs || null,
            b_chain:         hi.home_coin,
            b_action_index:  Number(hi.action_index),
            b_kind:          desc.hiKind,
            b_tick:          hi.give_tick || null,
            b_amount:        String(desc.hiFill),
            b_filled_before: String(desc.hiFilledBefore),
            b_ownership:     Number(hi.give_ownership || 0),
            b_payout_addr:   hi.get_address,           // B receives on lo's chain
            b_payout_legs:   hi.payout_legs || null,
            effective_time:  effectiveTime,
            // Per-leg source-chain reorg fence (item 5308): each leg lives on its own
            // chain with its own generation, stamped from that side's open-order RPC. A
            // source reorg retraction for chain C fences only the leg on C by its
            // generation, so a re-published order at a recycled action_index survives.
            // Metadata only; NOT part of the signed canonical.
            a_push_generation: Number(lo.push_generation) || 0,
            b_push_generation: Number(hi.push_generation) || 0
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
            this._inflight.delete(matchId);            // round failed to start; allow a retry
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
        //
        // FAIL CLOSED (item 2385): the match row + committed-ledger fill below depend
        // on this snapshot existing, so the persist is a precondition, not a best-effort
        // side-write. A swallowed DB throw, OR a silent zero-row persist (the sentinel
        // CapabilitySnapshot degrades to [] on an indexer RPC error / 401-403, so the
        // INSERT loop never runs, never throws, never warns), would leave a finalized,
        // mirrored, ledger-applied match whose validator_signatures no mirror can verify
        // against capability_snapshots: exactly the condition the ordering above exists
        // to prevent. On either failure we skip the insert/commit, drop the in-flight
        // reservation, and forget the finalized round id so the next poll re-proposes the
        // match cleanly (same defer-and-retry posture retractMatchesForReorg uses).
        let persistedRows = 0;
        try {
            persistedRows = await this._persistCapabilitySnapshot('cross_chain', Number(row.snapshot_block), row.network);
        } catch(e){
            console.error('CrossChainDex: snapshot persist on finalize FAILED (fail-closed; deferring match ' +
                          String(row.match_id).substring(0, 16) + '... to a later round): ' + (e && e.message));
            this._inflight.delete(row.match_id);
            if(this.consensus && typeof this.consensus.forgetFinalized === 'function') this.consensus.forgetFinalized(row.match_id);
            return;
        }
        if(!persistedRows){
            console.error('CrossChainDex: snapshot persist wrote ZERO capability rows for snapshot_block ' +
                          row.snapshot_block + ' (degraded/empty validator set; fail-closed, deferring match ' +
                          String(row.match_id).substring(0, 16) + '... to a later round)');
            this._inflight.delete(row.match_id);
            if(this.consensus && typeof this.consensus.forgetFinalized === 'function') this.consensus.forgetFinalized(row.match_id);
            return;
        }
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
    // match. A Byzantine leader cannot get us to sign a match we can't independently see.
    async validateProposedMatch(row){
        if(!row || row.a_chain === row.b_chain) return false;
        // Canonical integer spellings. These fields are signed verbatim but the
        // indexer's settlement pass rebuilds the canonical from the mirrored BIGINT row,
        // so a leader-supplied '041' for an action index passes every Number()-based
        // re-derivation below yet finalizes a match whose signatures no settling indexer
        // can reproduce - both escrows locked with no path to retry. Fail closed first;
        // an honest leader builds these with Number(), so an honest round never sees it.
        if(!allCanonicalInts(row, DEX_CANONICAL_INT_FIELDS)) return false;
        // Leader-chosen effective_time is ADOPTED (it is not part of the match_id, so a
        // follower cannot re-derive it) and signed into the canonical. Bound it to a sane
        // window of our own clock, exactly as CrossChainCallEngine.validateProposedMatch
        // does for relay rows. The window is ASYMMETRIC. Its upper half stops a Byzantine
        // leader stamping a far-future effective_time and finalizing a match whose indexer
        // settlement (applied at effective_time <= block_time) never fires, locking BOTH
        // matched escrows indefinitely (a griefing / liveness attack). Its lower half is
        // the propagation floor (#4202): a match effective at or behind our clock is
        // eligible the instant it finalizes, so the indexer that already holds the
        // mirrored row settles a block ahead of one still receiving it and the two legs'
        // settlement action indexes diverge. Honest leaders now stamp a forward margin
        // sized to the slower leg, comfortably above RELAY_MIN_FUTURE_S, so neither half
        // rejects an honest proposal (same clock-skew tolerance as the call relay).
        let now = this._nowSeconds();
        if(!Number.isFinite(Number(row.effective_time)) ||
           Number(row.effective_time) - now > 3600 ||
           Number(row.effective_time) - now < RELAY_MIN_FUTURE_S) return false;
        let a = await this._findOpenOffer(row.a_chain, Number(row.a_action_index));
        let b = await this._findOpenOffer(row.b_chain, Number(row.b_action_index));
        if(!a || !b) return false;
        if((a.home_network || '') !== String(row.network || '')) return false;
        if((b.home_network || '') !== String(row.network || '')) return false;
        // Re-derive the WHOLE match (kind, fill amounts, filled-before offsets, match_id)
        // independently from our own view: offers + our committed ledger. The proposer's
        // a/b are canonical (a_chain <= b_chain), so _tryMatch(a, b) keeps lo=a, hi=b.
        let desc = this._tryMatch(a, b);
        if(!desc) return false;
        if(desc.loKind !== row.a_kind || desc.hiKind !== row.b_kind) return false;
        if(!this._amountsEqual(desc.loFill, row.a_amount) || !this._amountsEqual(desc.hiFill, row.b_amount)) return false;
        if(!this._amountsEqual(desc.loFilledBefore, row.a_filled_before) ||
           !this._amountsEqual(desc.hiFilledBefore, row.b_filled_before)) return false;
        // Royalty legs must match OUR OWN indexer's view of each order. The canonical is
        // built from the proposed row, so without this check a Byzantine leader could
        // strip or rewrite the legs and still collect honest signatures; the source
        // indexer stores the legs as one JSON string, so both views compare byte-equal.
        if(String(row.a_payout_legs || '') !== String(desc.lo.payout_legs || '')) return false;
        if(String(row.b_payout_legs || '') !== String(desc.hi.payout_legs || '')) return false;
        // Per-leg source-reorg fence (item 5308): a_push_generation / b_push_generation are
        // NOT part of the signed canonical or the match_id, so a Byzantine leader can stamp an
        // inflated generation that no honest post-reorg retraction (which fences on
        // <leg>_push_generation <= retraction_generation) can ever match, permanently pinning a
        // match on a rolled-back source order = a cross-chain double-spend. Re-derive each leg's
        // generation from OUR OWN open-order view and refuse a row whose fence disagrees. Honest
        // hubs read the same per-coin generation, so a synced federation never rejects; a follower
        // whose indexer briefly lags just defers signing until it catches up (same tolerance as
        // the effective_time bound above).
        if((Number(row.a_push_generation) || 0) !== (Number(desc.lo.push_generation) || 0)) return false;
        if((Number(row.b_push_generation) || 0) !== (Number(desc.hi.push_generation) || 0)) return false;
        let derivedId = this._deriveMatchId(desc.lo, desc.hi, Number(row.snapshot_block), desc.loFilledBefore, desc.hiFilledBefore);
        if(String(derivedId).toLowerCase() !== String(row.match_id).toLowerCase()) return false;
        return true;
    }

    // Look up a single still-open cross-chain offer on `coin` by action_index, gated on
    // minConfirmations. Returns the offer (tagged like _discoverAndMatch) or null.
    async _findOpenOffer(coin, actionIndex){
        if(!this.indexers[coin] || !this.indexers[coin].url) return null;
        let res;
        // Page the full book (XCC-2): a one-shot limit:500 silently fails to re-confirm any
        // offer whose action_index sits past the cap, which would wrongly reject a valid match.
        try { res = await this._fetchOpenOffers(coin, { limit: 500 }); }
        catch(e){ return null; }
        if(!res || !Array.isArray(res.orders) || !res.network) return null;
        let latest = Number(res.latest_block_index);
        let o = res.orders.find(x => Number(x.action_index) === actionIndex);
        if(!o) return null;
        if(Number.isFinite(latest) && Number.isFinite(Number(o.block_index)) &&
           (latest - Number(o.block_index) + 1) < this.minConfirmations[coin]) return null;   // not deep enough
        return Object.assign({ home_coin: coin, home_network: String(res.network) }, o);
    }

    // Canonical signing string. MUST byte-match the indexer's verifier (the cross-chain
    // settlement pass rebuilds this from the mirrored row). Phase B appends the fill fields
    // after `network` so the Phase-A field order is preserved. a_amount/b_amount carry the
    // FILL settled by this match; *_kind + *_filled_before disambiguate sequential fills.
    // `view` = the PBFT view this signature is taken at (the consensus passes the live
    // pending.view; the indexer/archive twins pass the persisted finalizing_view). At/above
    // the EQUIV flag-day the XMATCH content is wrapped in the uniform header (TAG=XDEX,
    // ROUND_ID=match_id, VIEW=view). Putting <view> in the signed bytes is what lets a
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
        // Cross-chain royalty legs ride the signed match at/above the CROSS_CHAIN_ROYALTY
        // flag-day (a colluding hub must not be able to strip a royalty at settlement);
        // below it the canonical is byte-identical to the legacy format.
        if(ccr.isCrossChainRoyaltyActive(r.snapshot_block, r.network))
            raw += '|' + String(r.a_payout_legs || '') + '|' + String(r.b_payout_legs || '');
        if(eq.isEquivHeaderActive(r.snapshot_block, r.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, r.match_id, (view != null ? view : 0), raw);
        return raw;
    }

    // Returns true iff the row was actually inserted (false on INSERT IGNORE dedupe), so the
    // caller only updates the committed ledger once per fill.
    async _insertMatchRow(row){
        let cols = ['match_id','snapshot_block','network',
                    'a_chain','a_action_index','a_kind','a_tick','a_amount','a_filled_before','a_ownership','a_payout_addr','a_payout_legs',
                    'b_chain','b_action_index','b_kind','b_tick','b_amount','b_filled_before','b_ownership','b_payout_addr','b_payout_legs',
                    'effective_time','finalizing_view','validator_signatures','a_push_generation','b_push_generation'];
        let vals = cols.map(c => row[c]);
        // INSERT IGNORE: match_id is unique, so a re-finalize (e.g. another hub or a
        // restart racing the poll) is a harmless no-op.
        let res = await this.db.doQuery(
            'INSERT IGNORE INTO cross_chain_matches (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')',
            vals);
        let inserted = !!(res && Number(res.affectedRows) > 0);
        // A retracted row keeps its (unique) match_id. When a reorg retracts a crossing and the
        // SAME crossing re-forms at the same BTC snapshot_block, _deriveMatchId yields the
        // identical id, so the INSERT IGNORE above no-ops against the stale 'retracted' row and
        // the re-formed match would be stranded (never settled, committed capacity never
        // re-applied) until the BTC tip advances and yields a new snapshot_block/id. Revive the
        // retracted row to 'finalized' with THIS round's signatures and treat the revive as a
        // fresh insert so the committed-fill ledger is re-applied. A row already 'finalized' is
        // left untouched (status='retracted' guard), preserving the double-finalize dedupe so a
        // genuine duplicate finalize never double-counts a fill.
        if(!inserted){
            let revive = await this.db.doQuery(
                "UPDATE cross_chain_matches SET status = 'finalized', validator_signatures = ?, " +
                "finalizing_view = ?, effective_time = ? WHERE match_id = ? AND status = 'retracted'",
                [row.validator_signatures, row.finalizing_view, row.effective_time, row.match_id]);
            if(revive && Number(revive.affectedRows) > 0) inserted = true;
        }
        // Mirror to indexers: re-read the row (to get its AUTO_INCREMENT id) and broadcast.
        if(this.broadcaster){
            let read = await this.db.doQuery('SELECT * FROM cross_chain_matches WHERE match_id = ? LIMIT 1', [row.match_id]);
            if(read.length) this.broadcaster.broadcastRow({ table: 'cross_chain_matches', row: read[0] });
        }
        return inserted;
    }

    // Resolve the qualifying validator set, normalized to { pubkey, source, weight, amount }.
    // At/above STAKE_WEIGHTED_QUORUM activation (keyed on the BTC snapshot_block +
    // network) this fetches the SOURCE-KEYED weights; below it, the legacy count set
    // (source='' , weight=amount): byte-for-byte the old membership/values, so the
    // pre-activation path and mirror rows are unchanged.
    async _resolveCapabilityValidators(capability, block, network){
        let validators = [];
        let weighted = swq.isStakeWeightedQuorumActive(block, network);
        if(this.capSnapshot){
            if(weighted){
                let snap = await this.capSnapshot.getWeightSnapshot(capability, block);
                if(snap && Array.isArray(snap.validators)){
                    validators = snap.validators.map(v => ({ pubkey: v.pubkey, source: String(v.source != null ? v.source : ''), weight: String(v.weight != null ? v.weight : '0'), amount: String(v.weight != null ? v.weight : '0') }));
                    // Carry the truncation flag through the .map so the consensus fails
                    // closed on an over-cap weighted snapshot (SWQ-TRUNC parity with the
                    // indexer consumers; meetsStakeThreshold under-counts a truncated S).
                    if(snap.truncated === true) validators.truncated = true;
                }
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
    // Returns the number of capability rows resolved (and persisted) for this
    // (capability, block). A return of 0 means the snapshot degraded to an empty
    // set (indexer RPC error / auth mismatch surfaces as a null snapshot, which
    // _resolveCapabilityValidators normalizes to []), so callers on the money path
    // can fail closed rather than committing a match whose signatures no mirror can
    // verify against capability_snapshots.
    async _persistCapabilitySnapshot(capability, block, network){
        let validators = await this._resolveCapabilityValidators(capability, block, network);
        // SWQ-TRUNC-MIRROR: a TRUNCATED set is never mirrored. The `.truncated`
        // marker fails this hub's own meetsStakeThreshold closed, but it is a JS array
        // property with no capability_snapshots column behind it, so persisting the capped
        // rows lets the off-BTC cross_chain verifiers read a partial set as COMPLETE and
        // finalize over an under-counted stake denominator the hub itself rejects. Zero
        // rows is the fail-closed answer here in both directions: the mirror read yields
        // S=0, and the 0 return is the money-path signal this method's header already
        // defines (callers defer the match instead of committing it). Parity with
        // StateCheckpointEngine/CrossChainCallEngine; keep the three in lockstep.
        if(validators && validators.truncated === true){
            console.warn('CrossChainDex: refusing to persist a TRUNCATED ' + capability +
                         ' capability snapshot at block ' + block +
                         ' (over the source cap; raise VALIDATOR_QUERY_LIMIT fleet-wide). No rows mirrored.');
            return 0;
        }
        // One statement for the whole set: a per-row loop left the mirror PARTIAL on any
        // single INSERT throw, and a partial set has no completeness marker so a verifier
        // reads it as COMPLETE. Rationale in lib/capability_snapshot_write.js. Parity with
        // StateCheckpointEngine and the other four writers.
        let rows = await snapWrite.writeCapabilitySnapshotRows(this.db, capability, block, validators);
        for(let row of rows){
            if(this.broadcaster){
                // Select back on the full widened uq_cap_snap
                // (snapshot_block, capability, signing_pubkey, source). A pubkey-only
                // select-back re-read the SAME row for every source of a delegated key
                // (LIMIT 1), so the mirror stream carried one source and the off-BTC
                // match verifier tallied an under-counted denominator. Inert below SWQ,
                // where source='' and there is one row per key.
                let r = await this.db.doQuery(
                    'SELECT * FROM capability_snapshots WHERE snapshot_block = ? AND capability = ? AND signing_pubkey = ? AND source = ? LIMIT 1',
                    [block, capability, row.signing_pubkey, row.source]);
                if(r.length) this.broadcaster.broadcastRow({ table: 'capability_snapshots', row: r[0] });
            }
        }
        return validators.length;
    }

    // Mark matches referencing a rolled-back source order as retracted and broadcast a
    // deletion so indexers skip / roll back. Called by reorg handling.
    // toActionIndex (optional) bounds the retraction to a CLOSED range [from, to] on the matching
    // leg for a DEFERRED retraction, so a match re-published inside the original open-ended range is
    // not retracted (item 5296). Absent => open-ended, the live behavior. Two-sided: the bound
    // applies to whichever leg (a/b) is on the reorged chain. The bound rides each broadcastDeletion.
    // retractionGeneration (optional, item 5308): each leg carries its OWN generation
    // (a_push_generation / b_push_generation). When present, the per-leg clause additionally
    // requires that leg's generation <= it, so a leg re-finalized at a recycled source action_index
    // (higher generation, post-rollback) survives. Omitted (older indexer) => no fence.
    async retractMatchesForReorg(chain, fromActionIndex, toActionIndex, retractionGeneration){
        // Fail-closed on a SUPPLIED-but-invalid bound: a malformed to/generation used to
        // collapse into the absent branch and widen this into an open-ended retraction, which also
        // restores capacity via _applyCommit below; the raw lower bound went into SQL uncoerced.
        let bounds = normalizeRetractionBounds(fromActionIndex, toActionIndex, retractionGeneration);
        if(bounds.error) throw new Error(bounds.error);
        let { from, to, gen, bounded, fenced } = bounds;
        // Per-leg clause for whichever side is on the reorged chain, fenced by THAT leg's generation.
        let legClause = (col, gcol) => "(" + col + "_chain = ? AND " + col + "_action_index >= ?" +
            (bounded ? " AND " + col + "_action_index <= ?" : "") +
            (fenced ? " AND " + gcol + " <= ?" : "") + ")";
        let legParams = () => {
            let p = [chain, from];
            if(bounded) p.push(to);
            if(fenced) p.push(gen);
            return p;
        };
        let where = "status = 'finalized' AND (" + legClause('a', 'a_push_generation') + " OR " + legClause('b', 'b_push_generation') + ")";
        let params = legParams().concat(legParams());
        let rows = await this.db.doQuery(
            "SELECT match_id, a_chain, a_action_index, a_amount, b_chain, b_action_index, b_amount FROM cross_chain_matches WHERE " + where,
            params);
        for(let r of rows){
            await this.db.doQuery("UPDATE cross_chain_matches SET status = 'retracted' WHERE match_id = ?", [r.match_id]);
            this._applyCommit(r, -1);                   // restore both legs' remaining capacity
            this._inflight.delete(r.match_id);
            // Clear the consensus finalized-ring entry (M-13): the match_id is the
            // round id, and without this a match re-formed after this reorg can never
            // re-finalize (propose() no-ops on a finalized id), stranding it in 'retracted'.
            this.consensus.forgetFinalized(r.match_id);
            if(this.broadcaster){
                let evt = { table: 'cross_chain_matches', source_chain: chain, from_action_index: from };
                if(bounded) evt.to_action_index = to;
                if(fenced) evt.retraction_generation = gen;
                // Ride the retraction-signing round when active (the round
                // dedups the per-row repeats by canonical); legacy unsigned otherwise.
                if(this.hub && this.hub.retractionConsensus)
                    this.hub.retractionConsensus.submitLocal(evt).catch(e => console.error('CrossChainDex: retraction submit error: ' + (e && e.message)));
                else
                    this.broadcaster.broadcastDeletion(evt);
            }
        }
    }

    // Fetch a chain's ENTIRE open cross-chain book, paging the indexer's keyset cursor until
    // it reports the book is no longer truncated (XCC-2). Returns { network, latest_block_index,
    // orders } shaped like a single getopencrosschainorders response, with orders accumulated
    // across pages. network + latest_block_index are pinned to the FIRST page so the caller's
    // confirmation-depth floor uses one consistent tip across the whole book. Bounded by a hard
    // page cap (defense against an indexer that keeps flagging truncated without advancing) and
    // by requiring the cursor to strictly advance each page. Older indexers that don't return a
    // next_cursor fall back to the max action_index in the batch; ones that never set truncated
    // (pre-XCC-2) resolve in a single page, unchanged.
    async _fetchOpenOffers(coin, opts){
        const MAX_PAGES = 40;                 // >= 20k offers at limit 500; a hard anti-spin bound
        let limit   = (opts && Number.isFinite(Number(opts.limit))) ? Number(opts.limit) : 500;
        let orders  = [];
        let network = '';
        let latest  = undefined;
        let after   = undefined;
        for(let page = 0; page < MAX_PAGES; page++){
            let params = { limit };
            if(after !== undefined) params.after_action_index = after;
            let res = await this._indexerCall(coin, 'getopencrosschainorders', params);
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
    }

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
