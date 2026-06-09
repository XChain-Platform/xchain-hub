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
 * XChain Hub - Cross-Chain DEX DOGE Audit Anchor
 *
 * Periodically batches finalized cross-chain matches, commits the batch to a
 * SHA-256 Merkle root, anchors that root on the DOGE chain, and stamps
 * batch_root + anchor_txid onto the matched rows — a public, tamper-evident
 * audit trail. A verifier later groups cross_chain_matches by batch_root,
 * recomputes the root over their canonicals, and checks it against the on-chain
 * tx at anchor_txid.
 *
 * AUDIT-ONLY: indexers settle from the 2f+1 signatures (cross_settle) and never
 * read the anchor, so it lives HUB-SIDE only — the back-fill UPDATE is not
 * mirrored (the indexer mirror is INSERT-IGNORE), and replica batch_root/
 * anchor_txid stay NULL by design.
 *
 * Mirrors OraclePublisher (the oracle_publish → DOGE pipeline): deterministic
 * rank election from the oracle_publish capability snapshot, DOGE balance
 * monitoring, and an injectable broadcast (broadcastFn hook, else the encoder +
 * walletSignFn pipeline) — reusing the SAME DOGE signer the price publisher uses.
 * The pending batch is the set of finalized matches with batch_root IS NULL, so
 * the DB is the durable queue (crash-safe on restart; no separate JSONL file).
 *
 * No-op when DOGE publishing is unconfigured (e.g. regtest) — like OraclePublisher.
 *
 ********************************************************************/

const crypto        = require('crypto');
const MerkleTree     = require('./MerkleTree.js');
const EncoderClient  = require('./EncoderClient.js');

class CrossChainDexAnchor {

    constructor(hub){
        this.hub      = hub;
        this.db       = hub.db;
        this.identity = hub.getIdentity ? hub.getIdentity() : null;

        let cfg = hub.p2pConfig || {};
        this.batchSize  = parseInt(process.env.XDEX_ANCHOR_BATCH_SIZE   || cfg.XDEX_ANCHOR_BATCH_SIZE   || '64');
        this.maxBatch   = parseInt(process.env.XDEX_ANCHOR_MAX_BATCH    || cfg.XDEX_ANCHOR_MAX_BATCH    || '1000');
        this.intervalMs = parseInt(process.env.XDEX_ANCHOR_INTERVAL_MS  || cfg.XDEX_ANCHOR_INTERVAL_MS  || '1800000'); // 30 min
        this.lowBalanceThreshold = parseFloat(process.env.DOGE_LOW_BALANCE_THRESHOLD || cfg.DOGE_LOW_BALANCE_THRESHOLD || '10');

        this.dogeAddress   = process.env.DOGE_ADDRESS    || cfg.DOGE_ADDRESS    || '';
        this.dogePubkeyHex = process.env.DOGE_PUBKEY_HEX || cfg.DOGE_PUBKEY_HEX || '';
        let encoderUrl = process.env.DOGE_ENCODER_URL || cfg.DOGE_ENCODER_URL || '';
        let encoderKey = process.env.DOGE_ENCODER_API_KEY || cfg.DOGE_ENCODER_API_KEY || '';
        this.encoder   = encoderUrl ? new EncoderClient(encoderUrl, encoderKey) : null;

        // Pluggable hooks (mirror OraclePublisher). When unset, the anchor borrows
        // the price publisher's signer so DOGE signing is configured once.
        this.broadcastFn  = null;
        this.walletSignFn = null;
        this.getBalanceFn = null;

        this._pending      = 0;          // in-memory flush trigger; DB is the source of truth
        this._flushing     = false;
        this._timer        = null;
        this._matchHandler = null;
        this._loggedNoPipeline = false;
    }

    setBroadcastHook(fn){ this.broadcastFn = fn; }
    setWalletSignHook(fn){ this.walletSignFn = fn; }
    setBalanceHook(fn){ this.getBalanceFn = fn; }

    async start(){
        if(this.hub.crossChainDex){
            this._matchHandler = (ev) => this.onMatchFinalized(ev).catch(err =>
                console.error('CrossChainDexAnchor: onMatchFinalized error:', err && err.message));
            this.hub.crossChainDex.on('match:finalized', this._matchHandler);
        }
        this._timer = setInterval(() => {
            this.flush().catch(err => console.error('CrossChainDexAnchor: interval flush error:', err && err.message));
        }, this.intervalMs);
        if(this._timer.unref) this._timer.unref();
        console.log('CrossChainDexAnchor started (batch ' + this.batchSize + ', interval ' + this.intervalMs + 'ms, address ' + (this.dogeAddress || '<unset>') + ')');
    }

    async stop(){
        if(this._timer){ clearInterval(this._timer); this._timer = null; }
        if(this._matchHandler && this.hub.crossChainDex){
            this.hub.crossChainDex.removeListener('match:finalized', this._matchHandler);
            this._matchHandler = null;
        }
    }

    async onMatchFinalized(/* { matchId } */){
        if(++this._pending >= this.batchSize) await this.flush();
    }

    // Anchor the current batch of unanchored matches if this node is the elected
    // anchorer. The batch = finalized cross_chain_matches with batch_root IS NULL.
    async flush(){
        if(this._flushing) return;
        this._flushing = true;
        try {
            let rows = await this.db.doQuery(
                "SELECT * FROM cross_chain_matches WHERE status = 'finalized' AND batch_root IS NULL ORDER BY match_id ASC LIMIT ?",
                [this.maxBatch]);
            if(!rows || rows.length === 0){ this._pending = 0; return; }

            // Deterministic anchorer election from the oracle_publish set, rotating by
            // BTC block (a down leader's batch is picked up at the next flush's block).
            let btcBlock = this.hub._resolveBtcLatestBlock ? await this.hub._resolveBtcLatestBlock() : null;
            let pubkeys  = await this._getActiveOraclePublishPubkeys(btcBlock);
            if(pubkeys.length > 0){
                let myRank = this._myRank(pubkeys);
                if(myRank === null) return;                                 // not an oracle_publish validator
                let leaderRank = (Number.isFinite(btcBlock) ? btcBlock : 0) % pubkeys.length;
                if(myRank !== leaderRank) return;                           // not our turn (failover next block)
            }

            let engine = this.hub.crossChainDex;
            if(!engine) return;
            let leaves = rows.map(r => crypto.createHash('sha256').update(engine._canonicalMatch(r), 'utf8').digest('hex'));
            let root   = MerkleTree.root(leaves);
            if(!root) return;

            let payload = ['XDEXANCHOR', '0', root, String(rows.length)].join('|');

            let signer = this._resolveSigner();
            let canBroadcast = signer.broadcastFn || (signer.encoder && signer.walletSignFn);
            if(!canBroadcast){
                if(!this._loggedNoPipeline){
                    console.warn('CrossChainDexAnchor: no DOGE broadcast pipeline configured — batch of ' + rows.length + ' matches will remain unanchored (set DOGE_ENCODER_URL + a wallet-sign hook)');
                    this._loggedNoPipeline = true;
                }
                return;
            }

            await this._checkBalance(signer);

            let broadcaster = signer.broadcastFn || ((p) => this._defaultBroadcast(p, signer));
            let result = await broadcaster(payload);
            let txid = result && result.txid ? result.txid : null;

            // Back-fill batch_root + anchor_txid on the batched rows (hub-side only —
            // NOT broadcast to the indexer mirror; the anchor is audit-only).
            let ids = rows.map(r => r.match_id);
            let placeholders = ids.map(() => '?').join(',');
            await this.db.doQuery(
                'UPDATE cross_chain_matches SET batch_root = ?, anchor_txid = ? WHERE match_id IN (' + placeholders + ')',
                [root, txid].concat(ids));

            this._pending = 0;
            console.log('CrossChainDexAnchor: anchored ' + rows.length + ' matches (root ' + root.substring(0,16) + '..., txid ' + txid + ')');
        } catch(e){
            console.error('CrossChainDexAnchor: flush failed:', e && e.message);
        } finally {
            this._flushing = false;
        }
    }

    // Resolve the DOGE signer: this anchor's own hooks, else borrow the price
    // publisher's (so the operator configures DOGE signing exactly once).
    _resolveSigner(){
        let op = this.hub.oraclePublisher || {};
        return {
            broadcastFn:  this.broadcastFn  || op.broadcastFn  || null,
            walletSignFn: this.walletSignFn || op.walletSignFn || null,
            getBalanceFn: this.getBalanceFn || op.getBalanceFn || null,
            encoder:      this.encoder      || op.encoder      || null
        };
    }

    // Default broadcast pipeline (mirror OraclePublisher._defaultBroadcast): build a
    // P2SH-encoded tx carrying the anchor payload, sign via the wallet hook, broadcast.
    async _defaultBroadcast(payload, signer){
        signer = signer || this._resolveSigner();
        if(!signer.encoder)      throw new Error('no encoder configured (set DOGE_ENCODER_URL)');
        if(!signer.walletSignFn) throw new Error('no wallet sign hook configured');
        if(!this.dogeAddress)    throw new Error('no DOGE_ADDRESS configured');
        let utxos = await signer.encoder.getUtxos(this.dogeAddress);
        if(!utxos || (Array.isArray(utxos) && utxos.length === 0)) throw new Error('no UTXOs available for ' + this.dogeAddress);
        let psbtResult = await signer.encoder.createTx({
            utxos: utxos, pubkey: this.dogeAddress, data: payload, change: this.dogeAddress, encoding: 'P2SH'
        });
        if(!psbtResult || !psbtResult.psbt) throw new Error('encoder returned no PSBT');
        let txHex = await signer.walletSignFn(psbtResult.psbt);
        if(!txHex || typeof txHex !== 'string') throw new Error('wallet sign hook returned invalid tx hex');
        return (await signer.encoder.broadcastTx(txHex)) || { txid: null };
    }

    async _checkBalance(signer){
        let balance = null;
        try {
            if(signer.getBalanceFn) balance = await signer.getBalanceFn();
            else if(signer.encoder && this.dogeAddress){
                let utxos = await signer.encoder.getUtxos(this.dogeAddress);
                if(Array.isArray(utxos)) balance = utxos.reduce((t, u) => t + (parseFloat(u.value || u.amount || 0) || 0), 0);
            }
        } catch(e){ return null; }
        if(balance !== null && balance < this.lowBalanceThreshold)
            console.warn('CrossChainDexAnchor: DOGE balance LOW (' + Number(balance).toFixed(4) + ' DOGE)');
        return balance;
    }

    // ── oracle_publish rank election (mirror OraclePublisher) ──────────────────
    _myRank(pubkeys){
        if(!this.identity) return null;
        let me = String(this.identity.getPubkeyHex()).toLowerCase();
        let idx = pubkeys.indexOf(me);
        return idx >= 0 ? idx : null;
    }
    async _getActiveOraclePublishPubkeys(blockIndex){
        if(!this.hub) return [];
        if(this.hub.capabilitySnapshot && blockIndex !== undefined && blockIndex !== null){
            try {
                let snap = await this.hub.capabilitySnapshot.getSnapshot('oracle_publish', blockIndex);
                if(snap && Array.isArray(snap.validators))
                    return snap.validators.map(v => String(v.pubkey).toLowerCase()).sort();
            } catch(e){ /* fall through */ }
        }
        if(!this.hub.capabilityRegistry) return [];
        try {
            let pubkeys = await this.hub.capabilityRegistry.getActiveValidators('oracle_publish');
            return pubkeys.map(p => String(p).toLowerCase()).sort();
        } catch(e){ return []; }
    }
}

module.exports = CrossChainDexAnchor;
