/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
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

const ALLOWED_CHAINS = ['BTC', 'LTC', 'DOGE'];
const DEFAULT_POLL_MS = 15000;

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

        // Offers already committed to a finalized (non-retracted) match — keyed
        // `<chain>:<action_index>` — so we never match the same escrow twice before
        // the indexer settles it (the offer stays 'open' in getopencrosschainorders
        // until the indexer's settlement pass marks it complete). Rebuilt on startup
        // from cross_chain_matches.
        this.matchedOffers = new Set();

        this._pollTimer = null;
        this._messageHandler = null;
    }

    async start(){
        await this._rebuildMatchedOffers();
        if(this.peerManager){
            this._messageHandler = (envelope) => this._handleMessage(envelope);
            this.peerManager.on('message', this._messageHandler);
        }
        this._pollTimer = setInterval(() => {
            this._discoverAndMatch().catch(err => console.error('CrossChainDex: tick error:', err && err.message));
        }, this.pollMs);
        console.log('Cross-chain DEX engine started (poll ' + this.pollMs + 'ms)');
    }

    async stop(){
        if(this._pollTimer){ clearInterval(this._pollTimer); this._pollTimer = null; }
        if(this._messageHandler && this.peerManager){
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
    }

    // Rebuild the in-flight matched-offer set from finalized matches (restart safety).
    async _rebuildMatchedOffers(){
        try {
            let rows = await this.db.doQuery(
                "SELECT a_chain, a_action_index, b_chain, b_action_index FROM cross_chain_matches WHERE status = 'finalized'");
            for(let r of rows){
                this.matchedOffers.add(r.a_chain + ':' + r.a_action_index);
                this.matchedOffers.add(r.b_chain + ':' + r.b_action_index);
            }
        } catch(e){ /* table may not exist yet */ }
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
        for(let m of this._findMatches(offersByCoin)){
            let kA = m.a.home_coin + ':' + m.a.action_index;
            let kB = m.b.home_coin + ':' + m.b.action_index;
            if(this.matchedOffers.has(kA) || this.matchedOffers.has(kB)) continue;
            try {
                await this._finalizeMatch(m.a, m.b);
            } catch(e){
                console.error('CrossChainDex: finalizeMatch error:', e && e.message);
            }
        }
    }

    // Find compatible cross-chain pairs. Phase A: exact-match SWAP. Returns
    // [{ a, b }] with `a` the canonical-lower side (a.home_coin <= b.home_coin).
    _findMatches(offersByCoin){
        let all = [];
        for(let coin of ALLOWED_CHAINS) all = all.concat(offersByCoin[coin] || []);
        let matches = [], used = new Set();
        for(let i = 0; i < all.length; i++){
            let a = all[i], aKey = a.home_coin + ':' + a.action_index;
            if(used.has(aKey)) continue;
            for(let j = i + 1; j < all.length; j++){
                let b = all[j], bKey = b.home_coin + ':' + b.action_index;
                if(used.has(bKey)) continue;
                if(this._isExactMatch(a, b)){
                    matches.push((a.home_coin <= b.home_coin) ? { a, b } : { a: b, b: a });
                    used.add(aKey); used.add(bKey);
                    break;
                }
            }
        }
        return matches;
    }

    // True iff a and b are a clean cross-chain swap: each gives what the other wants.
    // NOTE: amount equality is string-exact for now; bignumber-normalized compare is a
    // refinement (different formatting of the same value would currently miss).
    _isExactMatch(a, b){
        if(a.home_coin === b.home_coin) return false;
        if((a.home_network || '') !== (b.home_network || '') || !a.home_network) return false; // never match across networks

        if(a.give_coin !== b.get_coin || a.get_coin !== b.give_coin) return false;
        if((a.give_tick || '') !== (b.get_tick || '')) return false;
        if((a.get_tick || '') !== (b.give_tick || '')) return false;
        if(String(a.give_amount) !== String(b.get_amount)) return false;
        if(String(a.get_amount) !== String(b.give_amount)) return false;
        if(Number(a.give_ownership || 0) !== Number(b.get_ownership || 0)) return false;
        if(Number(a.get_ownership || 0)  !== Number(b.give_ownership || 0)) return false;
        return true;
    }

    // ─── Finalize: sign + write the match row + persist the capability snapshot ──

    async _finalizeMatch(a, b){
        let snapshotBlock = await this._resolveSnapshotBlock();
        if(snapshotBlock == null) throw new Error('cannot resolve snapshot block');

        let matchId       = this._deriveMatchId(a, b, snapshotBlock);
        let effectiveTime = this._nowSeconds();

        // a = canonical-lower. On a's chain, a's escrow releases to b's payout (b.get_address,
        // b's receive addr on a's chain). On b's chain, b's escrow releases to a's payout.
        let row = {
            match_id:       matchId,
            snapshot_block: Number(snapshotBlock),
            network:        a.home_network,          // == b.home_network (enforced by _isExactMatch)
            a_chain:        a.home_coin,
            a_action_index: Number(a.action_index),
            a_tick:         a.give_tick || null,
            a_amount:       String(a.give_amount),
            a_ownership:    Number(a.give_ownership || 0),
            a_payout_addr:  a.get_address,           // A receives on b's chain
            b_chain:        b.home_coin,
            b_action_index: Number(b.action_index),
            b_tick:         b.give_tick || null,
            b_amount:       String(b.give_amount),
            b_ownership:    Number(b.give_ownership || 0),
            b_payout_addr:  b.get_address,           // B receives on a's chain
            effective_time: effectiveTime
        };

        // Persist the cross_chain validator snapshot at snapshot_block so every
        // indexer can verify these signatures (mandatory off-BTC; see design §5).
        await this._persistCapabilitySnapshot('cross_chain', Number(snapshotBlock));

        // Federation consensus on the match. Single-node (no quorum) signs directly.
        // TODO (multi-node): run a PBFT round (XDEX_MATCH_PROPOSE/PREPARE/COMMIT) over
        //   the canonical match before signing — see _handleMessage scaffold.
        let canonical = this._canonicalMatch(row);
        let sigs      = await this._collectSignatures(canonical);
        row.validator_signatures = JSON.stringify(sigs);

        // Write + mirror the finalized match.
        await this._insertMatchRow(row);
        this.matchedOffers.add(row.a_chain + ':' + row.a_action_index);
        this.matchedOffers.add(row.b_chain + ':' + row.b_action_index);

        console.log('CrossChainDex: finalized ' + matchId.substring(0, 16) + '... ' +
                    row.a_chain + ':' + row.a_action_index + ' ⇄ ' + row.b_chain + ':' + row.b_action_index);
        this.emit('match:finalized', { matchId });
    }

    // Canonical signing string. MUST byte-match the indexer's verifier (the
    // cross-chain settlement pass rebuilds this from the mirrored row).
    _canonicalMatch(r){
        return [
            'XMATCH', r.match_id, String(r.snapshot_block),
            r.a_chain, String(r.a_action_index), r.a_tick || '', String(r.a_amount), String(r.a_ownership), r.a_payout_addr,
            r.b_chain, String(r.b_action_index), r.b_tick || '', String(r.b_amount), String(r.b_ownership), r.b_payout_addr,
            String(r.effective_time), r.network || ''
        ].join('|');
    }

    // Single-node: our own signature. Multi-node: PBFT-collected 2f+1 (scaffold).
    async _collectSignatures(canonical){
        if(!this.identity) throw new Error('no validator identity — cannot sign cross-chain match');
        return [{ pubkey: this.identity.getPubkeyHex(), sig: this.identity.sign(canonical) }];
    }

    async _insertMatchRow(row){
        let cols = ['match_id','snapshot_block','network','a_chain','a_action_index','a_tick','a_amount','a_ownership','a_payout_addr',
                    'b_chain','b_action_index','b_tick','b_amount','b_ownership','b_payout_addr','effective_time','validator_signatures'];
        let vals = cols.map(c => row[c]);
        // INSERT IGNORE — match_id is unique, so a re-finalize (e.g. another hub or a
        // restart racing the poll) is a harmless no-op.
        await this.db.doQuery(
            'INSERT IGNORE INTO cross_chain_matches (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')',
            vals);
        // Mirror to indexers: re-read the row (to get its AUTO_INCREMENT id) and broadcast.
        if(this.broadcaster){
            let inserted = await this.db.doQuery('SELECT * FROM cross_chain_matches WHERE match_id = ? LIMIT 1', [row.match_id]);
            if(inserted.length) this.broadcaster.broadcastRow({ table: 'cross_chain_matches', row: inserted[0] });
        }
    }

    // Persist the qualifying validator set for `capability` at `block` to
    // capability_snapshots (idempotent), and mirror each row to indexers. The set is
    // resolved from the BTC indexer via CapabilitySnapshot (on-chain-deterministic).
    async _persistCapabilitySnapshot(capability, block){
        let validators = [];
        if(this.capSnapshot){
            let snap = await this.capSnapshot.getSnapshot(capability, block);
            if(snap && Array.isArray(snap.validators)) validators = snap.validators;
        }
        // Regtest seam: no BTC-sourced set → seed this hub's own validator pubkey.
        if(validators.length === 0 && this._seedLocalValidator && this.identity)
            validators = [{ pubkey: this.identity.getPubkeyHex(), amount: '1' }];
        for(let v of validators){
            let pubkey = String(v.pubkey).toLowerCase();
            let amount = String(v.amount != null ? v.amount : '0');
            await this.db.doQuery(
                'INSERT IGNORE INTO capability_snapshots (snapshot_block, capability, signing_pubkey, amount) VALUES (?, ?, ?, ?)',
                [block, capability, pubkey, amount]);
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
            "SELECT match_id, a_chain, a_action_index, b_chain, b_action_index FROM cross_chain_matches " +
            "WHERE status = 'finalized' AND ((a_chain = ? AND a_action_index >= ?) OR (b_chain = ? AND b_action_index >= ?))",
            [chain, fromActionIndex, chain, fromActionIndex]);
        for(let r of rows){
            await this.db.doQuery("UPDATE cross_chain_matches SET status = 'retracted' WHERE match_id = ?", [r.match_id]);
            this.matchedOffers.delete(r.a_chain + ':' + r.a_action_index);
            this.matchedOffers.delete(r.b_chain + ':' + r.b_action_index);
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
    // /^[0-9a-zA-Z_-]{1,80}$/ MATCH_ID rule). Binds both offers + the snapshot block.
    _deriveMatchId(a, b, snapshotBlock){
        let lo = (a.home_coin <= b.home_coin) ? a : b;
        let hi = (lo === a) ? b : a;
        // Bind network so an identical coin:index pair on two networks (e.g. regtest vs mainnet
        // LTC:5⇄DOGE:8 at the same block) can never collide on match_id.
        let s  = (a.home_network || '') + '|' + lo.home_coin + ':' + lo.action_index + '|' + hi.home_coin + ':' + hi.action_index + '|' + snapshotBlock;
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

    // ─── Multi-node PBFT scaffold ──────────────────────────────────────────
    // Federation path: a leader broadcasts XDEX_MATCH_PROPOSE(canonical match); peers
    // re-derive the match from their own synced order-book view, validate it (offers
    // open, amounts mirror, both escrows confirmed N-deep), and sign; signatures gather
    // to 2f+1 and go into validator_signatures. Mirrors AttestationConsensus. Not yet
    // wired — single-node finalize above is the regtest-testable slice.
    _handleMessage(/* envelope */){ /* TODO: XDEX_MATCH_PROPOSE/PREPARE/COMMIT */ }
}

module.exports = CrossChainDexEngine;
