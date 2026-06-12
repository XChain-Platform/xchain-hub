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
 * XChain Hub - State Checkpoint Engine
 *
 * Periodically produces quorum-signed checkpoints of each chain's indexer
 * state — the per-block ledger/actions/contract hash triple the indexer
 * already computes into its `blocks` table — so light clients can verify any
 * indexer/explorer response against `2f+1` `oracle_publish` signatures
 * instead of trusting a single operator. Checkpoints are OFF-CHAIN: written
 * to `state_checkpoints` and streamed over the hub-DB mirror (zero chain
 * writes); the StateAnchorPublisher separately commits the latest checkpoint
 * on-chain via the DOGE-only ANCHOR action.
 *
 * Round shape (leaner than CrossChainDexConsensus — a missed checkpoint is
 * benign, the next cadence retries under a rotated leader, so no view-change
 * machinery):
 *   1. The cadence leader (rank btcBlock % N over the sorted oracle_publish
 *      set — same election as OraclePublisher) reads each chain's hash triple
 *      from ITS OWN indexer, signs the XCHECKPOINT canonical, and broadcasts
 *      XCHK_SIGN_REQ.
 *   2. Every peer independently re-fetches the SAME block's triple from its
 *      own indexer/replica, signs only on byte-identical canonical, and
 *      replies XCHK_SIGN. A Byzantine leader cannot collect a quorum for
 *      state honest validators don't hold.
 *   3. At 2f+1 the leader broadcasts XCHK_FINALIZED with the full signature
 *      set; EVERY hub verifies the set and writes its own state_checkpoints
 *      row (mirroring _writeFinalizedMatch's everyone-writes pattern), then
 *      streams it to its indexer subscribers and emits checkpoint:finalized.
 *
 * Canonical signing string (must stay byte-identical to the indexer's ANCHOR
 * verifier and the SDK CheckpointVerifier — spec protocol/actions/ANCHOR.md):
 *   XCHECKPOINT|CHAIN|NETWORK|BLOCK_INDEX|BLOCK_HASH|LEDGER_HASH|ACTIONS_HASH|CONTRACT_HASH|CHECKPOINT_SEQ|SNAPSHOT_BLOCK
 *
 * Single-node fallback: oracle_publish set ≤ 1 (e.g. single-operator regtest)
 * collapses to immediate self-sign + write, like the other consensus engines.
 *
 ********************************************************************/

const EventEmitter      = require('events');
const axios             = require('axios');
const ValidatorIdentity = require('./ValidatorIdentity.js');

const XCHK_SIGN_REQ  = 'XCHK_SIGN_REQ';
const XCHK_SIGN      = 'XCHK_SIGN';
const XCHK_FINALIZED = 'XCHK_FINALIZED';

const ALLOWED_CHAINS = ['BTC', 'LTC', 'DOGE'];

class StateCheckpointEngine extends EventEmitter {

    constructor(hub){
        super();
        this.hub         = hub;
        this.db          = hub.db;
        this.peerManager = hub.getPeerManager ? hub.getPeerManager() : null;
        this.identity    = hub.getIdentity ? hub.getIdentity() : null;
        this.broadcaster = hub.hubDbBroadcaster || null;
        this.capSnapshot = hub.capabilitySnapshot || null;

        let cfg = hub.p2pConfig || {};
        this.enabled        = String(process.env.CHECKPOINT_ENABLED || cfg.CHECKPOINT_ENABLED || 'true') !== 'false';
        this.intervalBlocks = parseInt(process.env.CHECKPOINT_INTERVAL_BLOCKS || cfg.CHECKPOINT_INTERVAL_BLOCKS || '6');
        this.confirmations  = parseInt(process.env.CHECKPOINT_CONFIRMATIONS  || cfg.CHECKPOINT_CONFIRMATIONS  || '6');
        this.pollMs         = parseInt(process.env.CHECKPOINT_POLL_MS        || cfg.CHECKPOINT_POLL_MS        || '60000');
        this.roundTimeoutMs = parseInt(process.env.CHECKPOINT_ROUND_TIMEOUT_MS || cfg.CHECKPOINT_ROUND_TIMEOUT_MS || '60000');
        this.chains = String(process.env.CHECKPOINT_CHAINS || cfg.CHECKPOINT_CHAINS || ALLOWED_CHAINS.join(','))
            .split(',').map(c => c.trim().toUpperCase()).filter(c => ALLOWED_CHAINS.includes(c));

        // Regtest seams — shared with the cross-chain DEX engine so a no-BTC
        // regtest configures its deterministic anchor + seeded validator once.
        this._snapshotBlockOverride = parseInt(process.env.XDEX_SNAPSHOT_BLOCK || cfg.XDEX_SNAPSHOT_BLOCK);
        this._seedLocalValidator    = (process.env.XDEX_SEED_LOCAL_VALIDATOR === '1' ||
                                       cfg.XDEX_SEED_LOCAL_VALIDATOR === '1' || cfg.XDEX_SEED_LOCAL_VALIDATOR === true);

        // Per-coin indexer JSON-RPC endpoints (same env surface as CrossChainDexEngine).
        this.indexers = {};
        for(let coin of ALLOWED_CHAINS){
            this.indexers[coin] = {
                url: process.env[coin + '_INDEXER_URL'] || cfg[coin + '_INDEXER_URL'] || '',
                key: process.env[coin + '_INDEXER_API_KEY'] || cfg[coin + '_INDEXER_API_KEY'] || ''
            };
        }

        // Leader-side rounds in flight: Map<id, pending>. id = chain|network|block_index|seq.
        this.pending = new Map();

        this._lastCheckpointBtcBlock = null;     // leader cadence latch
        this._pollTimer      = null;
        this._messageHandler = null;
        this._ticking        = false;
    }

    async start(){
        if(!this.enabled){ console.log('StateCheckpointEngine: disabled (CHECKPOINT_ENABLED=false)'); return; }
        if(this.peerManager){
            this._messageHandler = (env) => this._handleMessage(env);
            this.peerManager.on('message', this._messageHandler);
        }
        this._pollTimer = setInterval(() => {
            this._tick().catch(err => console.error('StateCheckpointEngine: tick error:', err && err.message));
        }, this.pollMs);
        if(this._pollTimer.unref) this._pollTimer.unref();
        console.log('StateCheckpointEngine started (every ' + this.intervalBlocks + ' BTC blocks, chains ' + this.chains.join('/') + ')');
    }

    async stop(){
        if(this._pollTimer){ clearInterval(this._pollTimer); this._pollTimer = null; }
        if(this._messageHandler && this.peerManager){
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        for(let [, p] of this.pending){ if(p.timer) clearTimeout(p.timer); }
        this.pending.clear();
    }

    // ── Cadence (leader-only initiation; followers only react to SIGN_REQs) ────
    async _tick(){
        if(this._ticking) return;
        this._ticking = true;
        try {
            let btcBlock = await this._resolveSnapshotBlock();
            if(btcBlock == null) return;
            if(this._lastCheckpointBtcBlock != null && btcBlock < this._lastCheckpointBtcBlock + this.intervalBlocks) return;

            let validators = await this._resolveCapabilityValidators('oracle_publish', btcBlock);
            let pubkeys    = validators.map(v => String(v.pubkey).toLowerCase()).sort();
            // No oracle_publish set at all → nothing to sign authoritatively. A
            // checkpoint signed by a non-validator identity could never verify
            // against any capability snapshot. (Single-operator regtest seeds a
            // local validator via XDEX_SEED_LOCAL_VALIDATOR, so it still runs.)
            if(pubkeys.length === 0) return;
            if(pubkeys.length > 1){
                if(!this.identity) return;
                let me = this.identity.getPubkeyHex().toLowerCase();
                let myRank = pubkeys.indexOf(me);
                if(myRank < 0) return;                              // not an oracle_publish validator
                if(myRank !== (btcBlock % pubkeys.length)) return;  // not our cadence (rotates next block)
            }

            // We are the cadence leader (or a single-node set): one round per chain.
            // The latch advances even on per-chain failure — the next cadence retries.
            this._lastCheckpointBtcBlock = btcBlock;
            await this._persistCapabilitySnapshot('oracle_publish', btcBlock);
            for(let chain of this.chains){
                if(!this.indexers[chain].url) continue;
                try { await this._runRound(chain, btcBlock, validators); }
                catch(e){ console.warn('StateCheckpointEngine: ' + chain + ' round failed: ' + (e && e.message)); }
            }
        } finally {
            this._ticking = false;
        }
    }

    // ── Leader round for one chain ──────────────────────────────────────────────
    async _runRound(chain, snapshotBlock, validators){
        // Checkpoint the chain's tip minus a confirmation margin, so every peer's
        // indexer/replica has indexed the block and a shallow reorg can't race the round.
        let tip = await this._indexerCall(chain, 'getblockhashes', {});
        if(!tip || tip.block_index == null) throw new Error('no tip block hashes from ' + chain + ' indexer');
        let target = Number(tip.block_index) - this.confirmations;
        if(target < 0) target = Number(tip.block_index);
        let bh = (target === Number(tip.block_index)) ? tip : await this._indexerCall(chain, 'getblockhashes', { block_index: target });
        if(!bh || bh.block_index == null || !bh.block_hash) throw new Error('no block hashes for ' + chain + ' @ ' + target);

        let network = String(bh.network || '');
        if(!network) throw new Error(chain + ' indexer returned no network — refusing a network-agnostic checkpoint');
        let seq = await this._getNextCheckpointSeq(chain, network);

        let cp = {
            chain:          chain,
            network:        network,
            block_index:    Number(bh.block_index),
            block_hash:     String(bh.block_hash).toLowerCase(),
            ledger_hash:    String(bh.ledger_hash    || '').toLowerCase(),
            actions_hash:   String(bh.actions_hash   || '').toLowerCase(),
            contract_hash:  String(bh.contract_hash  || '').toLowerCase(),
            checkpoint_seq: seq,
            snapshot_block: Number(snapshotBlock)
        };
        let canonical = StateCheckpointEngine.canonicalCheckpoint(cp);
        let id        = this._roundId(cp);
        if(this.pending.has(id)) return;
        if(!this.identity) throw new Error('no validator identity — cannot sign checkpoints');

        let myPubkey = this.identity.getPubkeyHex().toLowerCase();
        let mySig    = this.identity.sign(canonical);
        let snapCount = validators.length;
        let quorum    = (snapCount <= 1) ? 1 : Math.max(2 * Math.floor((snapCount - 1) / 3) + 1, Math.ceil((snapCount + 1) / 2));

        // Single-node set: self-sign satisfies the quorum — finalize immediately.
        if(snapCount <= 1){
            await this._acceptFinalized(cp, [{ pubkey: myPubkey, sig: mySig }], quorum, true);
            return;
        }

        let pending = {
            id, cp, canonical, quorum,
            validators: validators.map(v => ({ pubkey: String(v.pubkey).toLowerCase() })),
            signatures: new Map([[myPubkey, mySig]]),
            done:       false,
            timer:      null
        };
        this.pending.set(id, pending);
        pending.timer = setTimeout(() => {
            this.pending.delete(id);
            if(!pending.done) console.warn('StateCheckpointEngine: round ' + id + ' timed out at ' +
                pending.signatures.size + '/' + quorum + ' sigs — retrying next cadence');
        }, this.roundTimeoutMs);
        if(pending.timer.unref) pending.timer.unref();

        this.peerManager.broadcast(XCHK_SIGN_REQ, { checkpoint: cp, sig_pubkey: myPubkey, sig: mySig });
        this._checkQuorum(id);
    }

    // ── P2P handlers ────────────────────────────────────────────────────────────
    _handleMessage(envelope){
        if(!envelope || !envelope.data) return;
        switch(envelope.type){
            case XCHK_SIGN_REQ:  this._handleSignReq(envelope).catch(e => console.error('StateCheckpointEngine: SIGN_REQ error: ' + (e && e.message))); break;
            case XCHK_SIGN:      this._handleSign(envelope);      break;
            case XCHK_FINALIZED: this._handleFinalized(envelope).catch(e => console.error('StateCheckpointEngine: FINALIZED error: ' + (e && e.message))); break;
        }
    }

    // Follower: independently confirm the proposed checkpoint against OUR OWN
    // indexer before signing — never sign state we don't hold ourselves.
    async _handleSignReq(envelope){
        let d  = envelope.data;
        let cp = this._normalizeCheckpoint(d.checkpoint);
        if(!cp || !this.identity) return;
        let myPubkey = this.identity.getPubkeyHex().toLowerCase();
        let sender   = String(d.sig_pubkey || '').toLowerCase();
        if(sender === myPubkey) return;                            // our own broadcast

        let validators = await this._resolveCapabilityValidators('oracle_publish', cp.snapshot_block);
        let pubkeys    = validators.map(v => String(v.pubkey).toLowerCase()).sort();
        if(!pubkeys.includes(myPubkey)) return;                    // we don't qualify — nothing to sign
        if(sender !== pubkeys[cp.snapshot_block % pubkeys.length]) return;   // not the cadence leader

        let canonical = StateCheckpointEngine.canonicalCheckpoint(cp);
        if(!ValidatorIdentity.verify(canonical, String(d.sig || ''), sender)) return;

        // Replay guard: never co-sign a seq at-or-below one we've already recorded.
        let maxSeq = await this._getMaxCheckpointSeq(cp.chain, cp.network);
        if(maxSeq != null && cp.checkpoint_seq <= maxSeq) return;

        // Independent confirmation from our own indexer/replica.
        let bh = null;
        try { bh = await this._indexerCall(cp.chain, 'getblockhashes', { block_index: cp.block_index }); }
        catch(e){ return; }                                        // can't confirm → don't sign
        if(!bh) return;
        let mine = StateCheckpointEngine.canonicalCheckpoint({
            chain: cp.chain, network: String(bh.network || ''), block_index: Number(bh.block_index),
            block_hash:    String(bh.block_hash    || '').toLowerCase(),
            ledger_hash:   String(bh.ledger_hash   || '').toLowerCase(),
            actions_hash:  String(bh.actions_hash  || '').toLowerCase(),
            contract_hash: String(bh.contract_hash || '').toLowerCase(),
            checkpoint_seq: cp.checkpoint_seq, snapshot_block: cp.snapshot_block
        });
        if(mine !== canonical){
            console.warn('StateCheckpointEngine: ' + cp.chain + '@' + cp.block_index + ' diverges from our indexer — NOT signing');
            return;
        }

        this.peerManager.broadcast(XCHK_SIGN, {
            id: this._roundId(cp), sig_pubkey: myPubkey, sig: this.identity.sign(canonical)
        });
    }

    // Leader: collect follower signatures.
    _handleSign(envelope){
        let d  = envelope.data;
        let id = String(d.id || '');
        let pending = this.pending.get(id);
        if(!pending || pending.done) return;
        let pubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!pending.validators.some(v => v.pubkey === pubkey)) return;
        if(!ValidatorIdentity.verify(pending.canonical, String(d.sig || ''), pubkey)) return;
        pending.signatures.set(pubkey, String(d.sig));
        this._checkQuorum(id);
    }

    _checkQuorum(id){
        let pending = this.pending.get(id);
        if(!pending || pending.done || pending.signatures.size < pending.quorum) return;
        pending.done = true;
        if(pending.timer){ clearTimeout(pending.timer); pending.timer = null; }
        this.pending.delete(id);
        let sigs = [];
        for(let [pk, sg] of pending.signatures) sigs.push({ pubkey: pk, sig: sg });
        this.peerManager.broadcast(XCHK_FINALIZED, { checkpoint: pending.cp, signatures: sigs });
        this._acceptFinalized(pending.cp, sigs, pending.quorum, true)
            .catch(e => console.error('StateCheckpointEngine: accept error: ' + (e && e.message)));
    }

    // Every hub verifies + writes the finalized checkpoint locally (the mirror
    // streams from each hub to ITS OWN indexer subscribers, so everyone writes).
    async _handleFinalized(envelope){
        let d  = envelope.data;
        let cp = this._normalizeCheckpoint(d.checkpoint);
        if(!cp || !Array.isArray(d.signatures)) return;

        let validators = await this._resolveCapabilityValidators('oracle_publish', cp.snapshot_block);
        let pubkeys    = new Set(validators.map(v => String(v.pubkey).toLowerCase()));
        let snapCount  = pubkeys.size;
        let quorum     = (snapCount <= 1) ? 1 : Math.max(2 * Math.floor((snapCount - 1) / 3) + 1, Math.ceil((snapCount + 1) / 2));

        let canonical = StateCheckpointEngine.canonicalCheckpoint(cp);
        let seen = new Set(), sigs = [];
        for(let s of d.signatures){
            let pk = String(s && s.pubkey || '').toLowerCase();
            if(!pk || seen.has(pk) || !pubkeys.has(pk)) continue;
            if(!ValidatorIdentity.verify(canonical, String(s.sig || ''), pk)) continue;
            seen.add(pk);
            sigs.push({ pubkey: pk, sig: String(s.sig) });
        }
        if(sigs.length < quorum) return;                           // sub-quorum — ignore
        await this._acceptFinalized(cp, sigs, quorum, false);
    }

    // Write the checkpoint row (append-only INSERT IGNORE — a reorged height is
    // superseded by a NEW row with a higher checkpoint_seq, never an UPDATE, so
    // the INSERT-IGNORE indexer mirror always converges), stream it to our
    // indexer subscribers, and emit for the StateAnchorPublisher.
    async _acceptFinalized(cp, sigs, quorum, isLeader){
        // EVERY hub persists the oracle_publish snapshot for the checkpoint's
        // snapshot_block, not just the cadence leader (_tick): ANCHOR verifiers
        // check the checkpoint's signatures against capability_snapshots in
        // whichever hub DB they mirror, and a follower's DB may be the only one
        // they read. Deterministic from BTC stakes + INSERT IGNORE, so all hubs
        // write identical rows. Persisted BEFORE the checkpoint row streams so a
        // mirror subscriber never sees a row it can't verify.
        try { await this._persistCapabilitySnapshot('oracle_publish', Number(cp.snapshot_block)); }
        catch(e){ console.warn('StateCheckpointEngine: snapshot persist on finalize failed: ' + (e && e.message)); }
        await this.db.doQuery(
            'INSERT IGNORE INTO state_checkpoints (chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash, checkpoint_seq, snapshot_block, validator_signatures) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [cp.chain, cp.network, cp.block_index, cp.block_hash, cp.ledger_hash, cp.actions_hash,
             cp.contract_hash, cp.checkpoint_seq, cp.snapshot_block, JSON.stringify(sigs)]);

        if(this.broadcaster){
            let r = await this.db.doQuery(
                'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? LIMIT 1',
                [cp.chain, cp.network, cp.block_index, cp.checkpoint_seq]);
            if(r.length) this.broadcaster.broadcastRow({ table: 'state_checkpoints', row: r[0] });
        }

        console.log('StateCheckpointEngine: checkpoint ' + cp.chain + '/' + cp.network + ' @ ' + cp.block_index +
                    ' seq ' + cp.checkpoint_seq + ' (' + sigs.length + '/' + quorum + ' sigs' + (isLeader ? ', leader' : '') + ')');
        this.emit('checkpoint:finalized', { checkpoint: cp, signatures: sigs });
    }

    // ── Canonical / helpers ─────────────────────────────────────────────────────

    // Byte-identical to the indexer ANCHOR verifier + SDK CheckpointVerifier.
    static canonicalCheckpoint(cp){
        return ['XCHECKPOINT', cp.chain, cp.network, String(cp.block_index), cp.block_hash,
                cp.ledger_hash, cp.actions_hash, cp.contract_hash,
                String(cp.checkpoint_seq), String(cp.snapshot_block)].join('|');
    }

    _roundId(cp){ return cp.chain + '|' + cp.network + '|' + cp.block_index + '|' + cp.checkpoint_seq; }

    _normalizeCheckpoint(raw){
        if(!raw || !raw.chain || !raw.network || raw.block_index == null) return null;
        let chain = String(raw.chain).toUpperCase();
        if(!ALLOWED_CHAINS.includes(chain)) return null;
        return {
            chain:          chain,
            network:        String(raw.network),
            block_index:    Number(raw.block_index),
            block_hash:     String(raw.block_hash    || '').toLowerCase(),
            ledger_hash:    String(raw.ledger_hash   || '').toLowerCase(),
            actions_hash:   String(raw.actions_hash  || '').toLowerCase(),
            contract_hash:  String(raw.contract_hash || '').toLowerCase(),
            checkpoint_seq: Number(raw.checkpoint_seq),
            snapshot_block: Number(raw.snapshot_block)
        };
    }

    async _getNextCheckpointSeq(chain, network){
        let r = await this.db.doQuery(
            'SELECT COALESCE(MAX(checkpoint_seq), -1) + 1 AS next_seq FROM state_checkpoints WHERE chain = ? AND network = ?',
            [chain, network]);
        return (r.length > 0) ? Number(r[0].next_seq) : 0;
    }

    async _getMaxCheckpointSeq(chain, network){
        let r = await this.db.doQuery(
            'SELECT MAX(checkpoint_seq) AS max_seq FROM state_checkpoints WHERE chain = ? AND network = ?',
            [chain, network]);
        return (r.length > 0 && r[0].max_seq != null) ? Number(r[0].max_seq) : null;
    }

    // Mirror CrossChainDexEngine._resolveCapabilityValidators (incl. regtest seam).
    async _resolveCapabilityValidators(capability, block){
        let validators = [];
        if(this.capSnapshot){
            let snap = await this.capSnapshot.getSnapshot(capability, block);
            if(snap && Array.isArray(snap.validators)) validators = snap.validators;
        }
        if(validators.length === 0 && this._seedLocalValidator && this.identity)
            validators = [{ pubkey: this.identity.getPubkeyHex(), amount: '1' }];
        return validators;
    }

    // Mirror CrossChainDexEngine._persistCapabilitySnapshot — the ANCHOR verifier
    // on the DOGE indexer resolves oracle_publish from the mirrored snapshots.
    async _persistCapabilitySnapshot(capability, block){
        let validators = await this._resolveCapabilityValidators(capability, block);
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

    async _resolveSnapshotBlock(){
        let b = this.hub._resolveBtcLatestBlock ? await this.hub._resolveBtcLatestBlock() : null;
        if(b != null) return b;
        return Number.isFinite(this._snapshotBlockOverride) ? this._snapshotBlockOverride : null;
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
}

module.exports = StateCheckpointEngine;
module.exports.XCHK_SIGN_REQ  = XCHK_SIGN_REQ;
module.exports.XCHK_SIGN      = XCHK_SIGN;
module.exports.XCHK_FINALIZED = XCHK_FINALIZED;
