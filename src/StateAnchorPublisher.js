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
 * XChain Hub - State Anchor Publisher (the ANCHOR action pipeline)
 *
 * Publishes the protocol's on-chain commitments on DOGE — and ONLY on DOGE,
 * so BTC/LTC carry zero anchor bytes (spec: protocol/actions/ANCHOR.md):
 *
 *   ANCHOR v0 — the latest quorum-signed state checkpoint per chain (signatures
 *               come straight from state_checkpoints; no new signing round).
 *   ANCHOR v1 — a checkpoint + a compressed archive of full cross_chain_matches
 *               rows (incl. their validator_signatures + the cross_chain
 *               capability_snapshots needed to re-verify them). This is what
 *               makes cross-chain match data recoverable from a full chain
 *               parse with no surviving hub DB.
 *   ANCHOR v2 — continuation chunks when a v1 archive exceeds the per-action
 *               data budget.
 *
 * The v1 canonical covers the archive structure (batch_seq, count, crc32 of the
 * UNCOMPRESSED JSON, total_chunks), so stored checkpoint signatures cannot
 * authenticate an archive. The publisher therefore runs a fresh signing round
 * (XANC_SIGN_REQ / XANC_SIGN) in which every follower verifies the proposed
 * archive AGAINST ITS OWN cross_chain_matches + capability_snapshots before
 * co-signing — a Byzantine elected publisher cannot collect a quorum for
 * fabricated matches or fabricated snapshots. After on-chain publication the
 * leader broadcasts XANC_FINALIZED so every hub back-fills batch_seq /
 * archived_status (audit metadata; harmless if missed — re-archival is
 * deduplicated by recovery's latest-status-wins).
 *
 * Re-archival rule: a match is pending when batch_seq IS NULL (never archived)
 * OR archived_status <> status (retracted after being archived as finalized).
 *
 * Election (attestation-style hash-ordering, spec §8.2 idiom): each pending
 * checkpoint elects its OWN publisher — oracle_publish validators at the
 * checkpoint's snapshot_block ordered by SHA256(election key ‖ pubkey)
 * ascending, where the key binds chain/network/seq/snapshot_block. Rank 0
 * publishes; if it hasn't after ANCHOR_ELECTION_TOLERANCE_BLOCKS BTC blocks,
 * rank 1 also qualifies, and so on (the DB row's anchor_txid IS NULL is the
 * shared "still pending" signal, so a late rank-0 and an early rank-1 can at
 * worst double-spend one anchor's fee, never corrupt state). A different
 * validator therefore publishes each chain's anchor in a cycle, FROM ITS OWN
 * DOGE WALLET — no UTXO contention between the per-chain anchors, per-chain
 * fault isolation, and publish work (plus its DOGE cost) spreads across the
 * federation. Each successful publish records an `anchor_<chain>` /
 * `anchor_archive` reward on the validator_rewards rail (oracle-round
 * pattern; INSERT IGNORE dedups, best-effort push to the BTC indexer for
 * COLLECT). The v1 archive round elects a single leader the same way with a
 * per-election-block key. Signer resolution, balance checks and the DOGE
 * broadcast pipeline mirror OraclePublisher (the DB is
 * the durable queue — pending checkpoints are rows with anchor_txid IS NULL,
 * pending matches per the rule above; crash-safe with no separate WAL file).
 * The degenerate single-validator federation keeps today's behavior: one
 * publisher, serialized spends from one wallet. Supersedes the legacy
 * XDEXANCHOR raw payload (CrossChainDexAnchor, retired 2026-06-11 after
 * ANCHOR verified end-to-end on mainnet).
 *
 ********************************************************************/

const zlib              = require('zlib');
const crypto            = require('crypto');
const EncoderClient     = require('./EncoderClient.js');
const ValidatorIdentity = require('./ValidatorIdentity.js');
const StateCheckpointEngine = require('./StateCheckpointEngine.js');

const XANC_SIGN_REQ  = 'XANC_SIGN_REQ';
const XANC_SIGN      = 'XANC_SIGN';
const XANC_FINALIZED = 'XANC_FINALIZED';
const XANC_V0_DONE   = 'XANC_V0_DONE';

// Fixed serialization order for an archived match row — the crc32 (and the
// follower byte-comparison) depend on this exact order. Spec §Archive JSON.
// `id` (the hub-assigned mirror cursor) is archived because it is the
// indexers' settlement-order key (getEffectiveUnsettledMatches ORDER BY id):
// recovery must rebuild rows under their original ids or a reindexing node
// could settle two same-block matches in a different order than live history
// (action_index divergence). Archives published before this field exist
// without it; recovery tolerates both shapes.
const MATCH_KEYS = ['id', 'match_id', 'snapshot_block', 'network',
    'a_chain', 'a_action_index', 'a_kind', 'a_tick', 'a_amount', 'a_filled_before', 'a_ownership', 'a_payout_addr',
    'b_chain', 'b_action_index', 'b_kind', 'b_tick', 'b_amount', 'b_filled_before', 'b_ownership', 'b_payout_addr',
    'effective_time', 'validator_signatures', 'status'];

// Fixed serialization order for an archived cross-chain CALL relay row (XCALL
// dispatch/result phases) — same crc32/byte-comparison rules as MATCH_KEYS.
// Without these in the archive, a full-chain-parse recovery could not rebuild
// the injected executions/callbacks and would diverge from live nodes.
// `id` (the hub-assigned mirror cursor) IS archived: it is the indexers'
// deterministic injection-order key, so recovery must rebuild rows under
// their original ids or a reindexing node would inject calls in a different
// order than live nodes did (action_index divergence).
const CALL_KEYS = ['id', 'call_id', 'phase', 'snapshot_block', 'network',
    'source_chain', 'source_action_index', 'source_contract_index',
    'target_chain', 'target_contract_index', 'method', 'params_json',
    'gas_limit', 'cross_hops', 'effective_time', 'result_status',
    'return_payload_b64', 'validator_signatures', 'status'];

class StateAnchorPublisher {

    constructor(hub){
        this.hub         = hub;
        this.db          = hub.db;
        this.identity    = hub.getIdentity ? hub.getIdentity() : null;
        this.peerManager = hub.getPeerManager ? hub.getPeerManager() : null;
        this.capSnapshot = hub.capabilitySnapshot || null;

        let cfg = hub.p2pConfig || {};
        this.enabled       = String(process.env.ANCHOR_ENABLED || cfg.ANCHOR_ENABLED || 'true') !== 'false';
        this.intervalMs    = parseInt(process.env.ANCHOR_INTERVAL_MS      || cfg.ANCHOR_INTERVAL_MS      || '86400000'); // daily
        this.batchSize     = parseInt(process.env.ANCHOR_MATCH_BATCH_SIZE || cfg.ANCHOR_MATCH_BATCH_SIZE || '200');
        this.maxBatch      = parseInt(process.env.ANCHOR_MAX_BATCH        || cfg.ANCHOR_MAX_BATCH        || '1000');
        this.chunkMaxBytes = parseInt(process.env.ANCHOR_CHUNK_MAX_BYTES  || cfg.ANCHOR_CHUNK_MAX_BYTES  || '6000');
        this.roundTimeoutMs = parseInt(process.env.ANCHOR_ROUND_TIMEOUT_MS || cfg.ANCHOR_ROUND_TIMEOUT_MS || '120000');
        this.chunkRetryDelayMs = parseInt(process.env.ANCHOR_CHUNK_RETRY_MS || cfg.ANCHOR_CHUNK_RETRY_MS || '2500');
        this.electionToleranceBlocks = parseInt(process.env.ANCHOR_ELECTION_TOLERANCE_BLOCKS || cfg.ANCHOR_ELECTION_TOLERANCE_BLOCKS || '36');
        this.lowBalanceThreshold = parseFloat(process.env.DOGE_LOW_BALANCE_THRESHOLD || cfg.DOGE_LOW_BALANCE_THRESHOLD || '10');

        this.dogeAddress   = process.env.DOGE_ADDRESS    || cfg.DOGE_ADDRESS    || '';
        this.dogePubkeyHex = process.env.DOGE_PUBKEY_HEX || cfg.DOGE_PUBKEY_HEX || '';
        let encoderUrl = process.env.DOGE_ENCODER_URL || cfg.DOGE_ENCODER_URL || '';
        let encoderKey = process.env.DOGE_ENCODER_API_KEY || cfg.DOGE_ENCODER_API_KEY || '';
        this.encoder   = encoderUrl ? new EncoderClient(encoderUrl, encoderKey) : null;

        // Pluggable hooks; unset → borrow the price publisher's DOGE signer.
        this.broadcastFn  = null;
        this.walletSignFn = null;
        this.getBalanceFn = null;

        this._archiveRound   = null;     // leader-side archive signing round (one at a time)
        this._pendingMatches = 0;        // size trigger; DB is the source of truth
        this._callHandler    = null;
        this._flushing       = false;
        this._timer          = null;
        this._messageHandler = null;
        this._matchHandler   = null;
        this._loggedNoPipeline = false;
    }

    setBroadcastHook(fn){ this.broadcastFn = fn; }
    setWalletSignHook(fn){ this.walletSignFn = fn; }
    setBalanceHook(fn){ this.getBalanceFn = fn; }

    async start(){
        if(!this.enabled){ console.log('StateAnchorPublisher: disabled (ANCHOR_ENABLED=false)'); return; }
        if(this.peerManager){
            this._messageHandler = (env) => this._handleMessage(env);
            this.peerManager.on('message', this._messageHandler);
        }
        if(this.hub.crossChainDex){
            this._matchHandler = () => {
                if(++this._pendingMatches >= this.batchSize)
                    this.flush().catch(err => console.error('StateAnchorPublisher: size-trigger flush error:', err && err.message));
            };
            // Engine-level event — fires after the match row is written (the archive
            // round reads cross_chain_matches), unlike the consensus-level event.
            this.hub.crossChainDex.on('match:finalized', this._matchHandler);
        }
        if(this.hub.crossChainCalls){
            // XCALL relay rows share the size trigger — they ride the same archive.
            this._callHandler = () => {
                if(++this._pendingMatches >= this.batchSize)
                    this.flush().catch(err => console.error('StateAnchorPublisher: size-trigger flush error:', err && err.message));
            };
            this.hub.crossChainCalls.on('call:dispatch', this._callHandler);
            this.hub.crossChainCalls.on('call:result',   this._callHandler);
        }
        this._timer = setInterval(() => {
            this.flush().catch(err => console.error('StateAnchorPublisher: interval flush error:', err && err.message));
        }, this.intervalMs);
        if(this._timer.unref) this._timer.unref();
        console.log('StateAnchorPublisher started (interval ' + this.intervalMs + 'ms, batch ' + this.batchSize + ', address ' + (this.dogeAddress || '<unset>') + ')');
    }

    async stop(){
        if(this._timer){ clearInterval(this._timer); this._timer = null; }
        if(this._messageHandler && this.peerManager){
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        if(this._matchHandler && this.hub.crossChainDex){
            this.hub.crossChainDex.removeListener('match:finalized', this._matchHandler);
            this._matchHandler = null;
        }
        if(this._callHandler && this.hub.crossChainCalls){
            this.hub.crossChainCalls.removeListener('call:dispatch', this._callHandler);
            this.hub.crossChainCalls.removeListener('call:result',   this._callHandler);
            this._callHandler = null;
        }
        if(this._archiveRound && this._archiveRound.timer) clearTimeout(this._archiveRound.timer);
        this._archiveRound = null;
    }

    // ── Flush: publish pending v0 checkpoints + the pending archive batch ──────
    // Returns a summary (also served by the hub's `anchorflush` RPC):
    // { anchored: [{chain, network, block_index, txid}], archive: 'published'|
    //   'round_started'|'none', skipped: 'already_flushing'|'no_pipeline'? }
    async flush(){
        if(this._flushing) return { anchored: [], archive: 'none', skipped: 'already_flushing' };
        this._flushing = true;
        try {
            let btcBlock = this.hub._resolveBtcLatestBlock ? await this.hub._resolveBtcLatestBlock() : null;

            let signer = this._resolveSigner();
            if(!signer.broadcastFn && !(signer.encoder && signer.walletSignFn)){
                if(!this._loggedNoPipeline){
                    console.warn('StateAnchorPublisher: no DOGE broadcast pipeline configured — anchors deferred (set DOGE_ENCODER_URL + a wallet-sign hook)');
                    this._loggedNoPipeline = true;
                }
                return { anchored: [], archive: 'none', skipped: 'no_pipeline' };
            }
            await this._checkBalance(signer);

            let anchored = await this._publishPendingCheckpoints(signer, btcBlock);
            let archive  = await this._startArchiveRound(signer, btcBlock);
            return { anchored: anchored, archive: archive };
        } catch(e){
            console.error('StateAnchorPublisher: flush failed:', e && e.message);
            return { anchored: [], archive: 'none', error: e && e.message };
        } finally {
            this._flushing = false;
        }
    }

    // Deterministic publisher ordering — AttestationRound's responsible-set
    // idiom: sort the eligible set by SHA256(key ‖ pubkey) ascending. Every
    // hub computes the identical order from the block-boundary snapshot.
    static hashOrder(key, pubkeys){
        return (pubkeys || []).map(pk => {
            let p = String(pk).toLowerCase();
            return { pubkey: p, hash: crypto.createHash('sha256').update(key, 'utf8').update(p, 'utf8').digest('hex') };
        }).sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0)).map(e => e.pubkey);
    }

    _v0ElectionKey(row){
        return 'XANCV0|' + row.chain + '|' + row.network + '|' + String(row.checkpoint_seq) + '|' + String(row.snapshot_block);
    }

    // May THIS hub publish for `order` right now? Rank 0 always may; each
    // additional rank unlocks after ANCHOR_ELECTION_TOLERANCE_BLOCKS more BTC
    // blocks past the election anchor point (deterministic failover ladder).
    // A hub outside a non-empty eligible set never publishes.
    _mayPublish(order, sinceBlocks){
        if(order.length === 0) return true;
        if(!this.identity) return false;
        let rank = order.indexOf(String(this.identity.getPubkeyHex()).toLowerCase());
        if(rank < 0) return false;
        if(order.length === 1) return true;
        let unlocked = Number.isFinite(sinceBlocks) ? Math.floor(Math.max(0, sinceBlocks) / this.electionToleranceBlocks) : 0;
        return rank <= unlocked;
    }

    // v0: one per chain/network — the LATEST checkpoint that has no anchor yet.
    // Older unanchored checkpoints are superseded (the chained hashes commit to
    // all prior history), so only the newest per chain costs DOGE bytes.
    // Each row elects its own publisher (hash-order at its snapshot_block).
    async _publishPendingCheckpoints(signer, btcBlock){
        let rows = await this.db.doQuery(
            'SELECT sc.* FROM state_checkpoints sc JOIN (' +
            '  SELECT chain, network, MAX(checkpoint_seq) AS max_seq FROM state_checkpoints GROUP BY chain, network' +
            ') t ON sc.chain = t.chain AND sc.network = t.network AND sc.checkpoint_seq = t.max_seq ' +
            'WHERE sc.anchor_txid IS NULL');
        let anchored = [];
        for(let row of (rows || [])){
            try {
                let eligible = await this._getActiveOraclePublishPubkeys(Number(row.snapshot_block));
                if(eligible.length > 0){
                    let order = StateAnchorPublisher.hashOrder(this._v0ElectionKey(row), eligible);
                    let since = Number.isFinite(btcBlock) ? btcBlock - Number(row.snapshot_block) : null;
                    if(!this._mayPublish(order, since)) continue;        // someone else's anchor (or not unlocked yet)
                }
                let payload = this._buildV0Payload(row);
                let broadcaster = signer.broadcastFn || ((p) => this._defaultBroadcast(p, signer));
                let result = await broadcaster(payload);
                let txid = result && result.txid ? result.txid : null;
                await this.db.doQuery(
                    'UPDATE state_checkpoints SET anchor_txid = ? WHERE chain = ? AND network = ? AND block_index = ?',
                    [txid, row.chain, row.network, row.block_index]);
                console.log('StateAnchorPublisher: anchored checkpoint ' + row.chain + '/' + row.network +
                            ' @ ' + row.block_index + ' (txid ' + txid + ')');
                anchored.push({ chain: row.chain, network: row.network, block_index: Number(row.block_index), txid: txid });
                this._recordReward('anchor_' + row.chain, Number(row.checkpoint_seq), btcBlock);
                // Tell peers so THEIR copy of the row stops being pending —
                // without this, every hub whose failover rank unlocks would
                // re-anchor a checkpoint someone else already paid for.
                if(this.peerManager && this.identity){
                    this.peerManager.broadcast(XANC_V0_DONE, {
                        chain: row.chain, network: row.network, block_index: Number(row.block_index),
                        checkpoint_seq: Number(row.checkpoint_seq), txid: txid,
                        sig_pubkey: this.identity.getPubkeyHex().toLowerCase(),
                        sig: this.identity.sign(this._v0DoneCanonical(row, txid))
                    });
                }
            } catch(e){
                console.error('StateAnchorPublisher: v0 publish failed for ' + row.chain + ': ' + (e && e.message));
            }
        }
        return anchored;
    }

    // Publisher-side reward (oracle-round rail): the validator that paid the
    // DOGE earns it. INSERT IGNORE on (pubkey, round, type) dedups retries.
    _recordReward(rewardType, roundNumber, btcBlock){
        if(!this.identity || !this.hub.rewardTracker || typeof this.hub.rewardTracker.recordAnchorReward !== 'function') return;
        this.hub.rewardTracker
            .recordAnchorReward(rewardType, roundNumber, this.identity.getPubkeyHex().toLowerCase(), Number.isFinite(btcBlock) ? btcBlock : 0)
            .catch(e => console.warn('StateAnchorPublisher: reward record failed (' + rewardType + '/' + roundNumber + '): ' + (e && e.message)));
    }

    _buildV0Payload(row){
        let sigs = this._parseSigs(row.validator_signatures);
        let parts = ['ANCHOR', '0', row.chain, row.network, String(row.block_index), row.block_hash,
                     row.ledger_hash, row.actions_hash, row.contract_hash,
                     String(row.checkpoint_seq), String(row.snapshot_block), String(sigs.length)];
        for(let s of sigs) parts.push(s.pubkey, s.sig);
        return parts.join('|');
    }

    // ── Archive round (v1/v2) ───────────────────────────────────────────────────
    // One leader per election block: hash-order rank 0 over the oracle_publish
    // set (failover = next block ⇒ new key ⇒ new leader). Returns the flush
    // summary's archive status.
    async _startArchiveRound(signer, electionBlock){
        if(this._archiveRound) return 'round_pending';                       // one at a time

        let pubkeys = await this._getActiveOraclePublishPubkeys(electionBlock);
        if(pubkeys.length > 0){
            if(!this.identity) return 'none';
            let me = String(this.identity.getPubkeyHex()).toLowerCase();
            if(!pubkeys.includes(me)){
                console.log('StateAnchorPublisher: archive election at block ' + electionBlock +
                            ' — own pubkey not in the oracle_publish set (' + pubkeys.length + ' eligible)');
                return 'none';                                               // not an oracle_publish validator
            }
            if(pubkeys.length > 1){
                let order = StateAnchorPublisher.hashOrder(this._archiveElectionKey(electionBlock), pubkeys);
                if(order[0] !== me){
                    // Operator visibility: a hub that never wins the archive
                    // election (e.g. signer-less peers keep ranking first) is
                    // indistinguishable from a broken publisher without this.
                    console.log('StateAnchorPublisher: archive election at block ' + electionBlock +
                                ' — rank ' + order.indexOf(me) + '/' + order.length + ' (leader ' +
                                order[0].substring(0, 12) + '...), not publishing');
                    return 'none';                                           // not the elected archive leader
                }
            }
        }

        let matches = await this.db.doQuery(
            "SELECT * FROM cross_chain_matches WHERE batch_seq IS NULL OR archived_status <> status " +
            "ORDER BY match_id ASC LIMIT ?", [this.maxBatch]);
        let calls = await this.db.doQuery(
            "SELECT * FROM cross_chain_calls WHERE batch_seq IS NULL OR archived_status <> status " +
            "ORDER BY call_id ASC, phase ASC LIMIT ?", [this.maxBatch]);
        if((!matches || matches.length === 0) && (!calls || calls.length === 0)){ this._pendingMatches = 0; return 'none'; }
        matches = matches || [];
        calls   = calls   || [];

        // The checkpoint wrapper: latest checkpoint (prefer BTC — its height also
        // selects validator sets). Without any checkpoint there is nothing to bind
        // the archive's signatures to — defer until the checkpoint engine has run.
        let cps = await this.db.doQuery(
            "SELECT * FROM state_checkpoints ORDER BY (chain = 'BTC') DESC, id DESC LIMIT 1");
        if(!cps || cps.length === 0){
            console.log('StateAnchorPublisher: no state checkpoint yet — archive deferred');
            return 'none';
        }
        let cp = this._cpFromRow(cps[0]);

        let network  = String(cps[0].network);
        let batchSeq = await this._getNextBatchSeq();
        let archive  = await this._buildArchive(network, batchSeq, matches, cp.snapshot_block, calls);
        let json     = archive.json;
        let crc      = this._crc32Hex(json);
        let b64      = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64url');
        let chunks   = this._splitChunks(b64);

        let canonical = this._archiveCanonical(cp, batchSeq, archive.count, crc, chunks.length);
        if(!this.identity) throw new Error('no validator identity — cannot sign archives');
        let myPubkey = this.identity.getPubkeyHex().toLowerCase();
        let mySig    = this.identity.sign(canonical);

        let snapCount = pubkeys.length;
        let quorum    = (snapCount <= 1) ? 1 : Math.max(2 * Math.floor((snapCount - 1) / 3) + 1, Math.ceil((snapCount + 1) / 2));

        let round = {
            cp, batchSeq, crc, b64, chunks, canonical, quorum, signer, electionBlock,
            count:      archive.count,
            matchIds:   matches.map(m => ({ match_id: m.match_id, status: m.status })),
            callIds:    calls.map(c => ({ call_id: c.call_id, phase: c.phase, status: c.status })),
            validators: pubkeys.slice(),
            signatures: new Map([[myPubkey, mySig]]),
            done:       false,
            timer:      null
        };

        if(snapCount <= 1){                                                   // single-node: self-sign suffices
            await this._publishArchive(round);
            this._pendingMatches = 0;
            return 'published';
        }

        this._archiveRound = round;
        round.timer = setTimeout(() => {
            if(this._archiveRound === round && !round.done){
                console.warn('StateAnchorPublisher: archive round (batch ' + batchSeq + ') timed out at ' +
                             round.signatures.size + '/' + quorum + ' sigs — retrying next flush');
                this._archiveRound = null;
            }
        }, this.roundTimeoutMs);
        if(round.timer.unref) round.timer.unref();

        this.peerManager.broadcast(XANC_SIGN_REQ, {
            checkpoint: cp, batch_seq: batchSeq, match_count: archive.count,
            batch_crc32: crc, total_chunks: chunks.length, archive_b64: b64,
            election_block: (Number.isFinite(electionBlock) ? electionBlock : 0),
            sig_pubkey: myPubkey, sig: mySig
        });
        await this._checkArchiveQuorum();
        return 'round_started';
    }

    _archiveElectionKey(electionBlock){
        return 'XANCV1|' + String(Number.isFinite(electionBlock) ? electionBlock : 0);
    }

    // Resolve the qualifying set for (capability, block). Primary source is
    // CapabilitySnapshot.getSnapshot — deterministic from on-chain BTC stakes,
    // identical on EVERY hub — so the archive builder (leader) and the archive
    // verifier (followers) agree regardless of which hub led past rounds (the
    // local capability_snapshots table only holds rows a hub persisted while
    // leading, so it can't be the shared source). Falls back to the local
    // table for seeded/regtest stacks with no live BTC resolution.
    async _resolveCapabilitySet(capability, block){
        if(this.capSnapshot){
            try {
                let snap = await this.capSnapshot.getSnapshot(capability, Number(block));
                if(snap && Array.isArray(snap.validators) && snap.validators.length > 0)
                    return snap.validators.map(v => ({ pubkey: String(v.pubkey).toLowerCase(), amount: String(v.amount != null ? v.amount : '0') }));
            } catch(e){ /* fall through to the local table */ }
        }
        let rows = await this.db.doQuery(
            "SELECT signing_pubkey, amount FROM capability_snapshots WHERE snapshot_block = ? AND capability = ? ORDER BY signing_pubkey ASC",
            [Number(block), String(capability)]);
        return (rows || []).map(r => ({ pubkey: String(r.signing_pubkey).toLowerCase(), amount: String(r.amount) }));
    }

    // Archive JSON with fixed key order (crc32-bearing bytes — see MATCH_KEYS).
    // capability_snapshots makes recovery self-contained: cross_chain rows for
    // every match's snapshot_block (to re-verify match signatures) PLUS the
    // oracle_publish rows at the wrapper checkpoint's snapshot_block (to
    // re-verify the v1 anchor's own signatures). Recovery additionally
    // cross-checks archived pubkeys against on-chain BTC stakes — archived
    // sets are a convenience, the chain remains the root of trust.
    async _buildArchive(network, batchSeq, matches, wrapperSnapshotBlock, calls){
        calls = calls || [];
        let wants = matches.map(m => ({ block: Number(m.snapshot_block), capability: 'cross_chain' }))
            .concat(calls.map(c => ({ block: Number(c.snapshot_block), capability: 'cross_chain' })));
        if(wrapperSnapshotBlock != null)
            wants.push({ block: Number(wrapperSnapshotBlock), capability: 'oracle_publish' });
        let seen = new Set(), snaps = [];
        for(let w of wants.sort((a, b) => a.block - b.block || (a.capability < b.capability ? -1 : 1))){
            let key = w.block + '|' + w.capability;
            if(seen.has(key)) continue;
            seen.add(key);
            let set = await this._resolveCapabilitySet(w.capability, w.block);
            for(let v of set.slice().sort((a, b) => a.pubkey < b.pubkey ? -1 : 1))
                snaps.push({ snapshot_block: w.block, capability: w.capability,
                             signing_pubkey: v.pubkey, amount: v.amount });
        }
        // `calls` is additive to the v1 archive shape: recovery treats a missing
        // key as an empty list, so pre-XCALL archives on-chain stay parseable.
        let obj = {
            v: 1,
            network: network,
            batch_seq: batchSeq,
            matches: matches.map(m => StateAnchorPublisher.serializeMatch(m)),
            calls: calls.map(c => StateAnchorPublisher.serializeCall(c)),
            capability_snapshots: snaps
        };
        return { json: JSON.stringify(obj), count: matches.length };
    }

    // Fixed-key-order match record (shared with the follower verifier + recovery).
    static serializeMatch(m){
        let out = {};
        for(let k of MATCH_KEYS){
            let v = m[k];
            if(k === 'id' || k === 'a_action_index' || k === 'b_action_index' || k === 'snapshot_block' || k === 'effective_time')
                out[k] = Number(v);
            else if(k === 'a_ownership' || k === 'b_ownership')
                out[k] = Number(v) ? 1 : 0;
            else if(k === 'a_tick' || k === 'b_tick')
                out[k] = (v == null) ? null : String(v);
            else
                out[k] = String(v == null ? '' : v);
        }
        return out;
    }

    // Fixed-key-order XCALL relay record (shared with the follower verifier +
    // recovery). result_status / return_payload_b64 are null on dispatch rows.
    static serializeCall(c){
        let out = {};
        for(let k of CALL_KEYS){
            let v = c[k];
            if(k === 'id' || k === 'snapshot_block' || k === 'source_action_index' || k === 'source_contract_index' ||
               k === 'target_contract_index' || k === 'gas_limit' || k === 'cross_hops' || k === 'effective_time')
                out[k] = Number(v);
            else if(k === 'result_status' || k === 'return_payload_b64')
                out[k] = (v == null) ? null : String(v);
            else
                out[k] = String(v == null ? '' : v);
        }
        return out;
    }

    _archiveCanonical(cp, batchSeq, count, crc, totalChunks){
        return StateCheckpointEngine.canonicalCheckpoint(cp) + '|' +
               String(batchSeq) + '|' + String(count) + '|' + crc + '|' + String(totalChunks);
    }

    _splitChunks(b64){
        let chunks = [];
        for(let i = 0; i < b64.length; i += this.chunkMaxBytes) chunks.push(b64.slice(i, i + this.chunkMaxBytes));
        return chunks.length ? chunks : [''];
    }

    // ── P2P handlers ────────────────────────────────────────────────────────────
    _handleMessage(envelope){
        if(!envelope || !envelope.data) return;
        switch(envelope.type){
            case XANC_SIGN_REQ:  this._handleSignReq(envelope).catch(e => console.error('StateAnchorPublisher: SIGN_REQ error: ' + (e && e.message))); break;
            case XANC_SIGN:      this._handleSign(envelope).catch(e => console.error('StateAnchorPublisher: SIGN error: ' + (e && e.message)));        break;
            case XANC_FINALIZED: this._handleFinalized(envelope).catch(e => console.error('StateAnchorPublisher: FINALIZED error: ' + (e && e.message))); break;
            case XANC_V0_DONE:   this._handleV0Done(envelope).catch(e => console.error('StateAnchorPublisher: V0_DONE error: ' + (e && e.message)));     break;
        }
    }

    // Peer back-fill for a published v0 anchor. Anti-spam only (membership +
    // signature) — a fabricated txid can at worst suppress a re-anchor, and the
    // row's hashes were already quorum-signed. First writer wins (IS NULL guard).
    async _handleV0Done(envelope){
        let d = envelope.data;
        if(!d || !d.chain || !d.txid) return;
        let sender = String(d.sig_pubkey || '').toLowerCase();
        let pubkeys = await this._getActiveOraclePublishPubkeys(null);
        if(pubkeys.length && !pubkeys.includes(sender)) return;
        if(!ValidatorIdentity.verify(this._v0DoneCanonical(d, String(d.txid)), String(d.sig || ''), sender)) return;
        await this.db.doQuery(
            'UPDATE state_checkpoints SET anchor_txid = ? WHERE chain = ? AND network = ? AND block_index = ? AND anchor_txid IS NULL',
            [String(d.txid), String(d.chain), String(d.network), Number(d.block_index)]);
    }

    _v0DoneCanonical(row, txid){
        return 'XANCV0DONE|' + row.chain + '|' + row.network + '|' + String(row.block_index) + '|' +
               String(row.checkpoint_seq) + '|' + String(txid || '');
    }

    // Follower: co-sign ONLY an archive that byte-matches our own DB state.
    async _handleSignReq(envelope){
        let d = envelope.data;
        if(!this.identity || !d || !d.checkpoint) return;
        let myPubkey = this.identity.getPubkeyHex().toLowerCase();
        let sender   = String(d.sig_pubkey || '').toLowerCase();
        if(sender === myPubkey) return;

        let cp = d.checkpoint;
        // The publisher is elected by the CURRENT BTC block (not the checkpoint's
        // possibly hours-old snapshot_block). The REQ carries its election block;
        // we verify the sender's rank against it, bounded to our own view of the
        // BTC tip (anti-spam — the security property is the DB byte-match below).
        let electionBlock = Number(d.election_block);
        if(!Number.isFinite(electionBlock)) return;
        let myBtc = this.hub._resolveBtcLatestBlock ? await this.hub._resolveBtcLatestBlock() : null;
        if(Number.isFinite(myBtc) && Math.abs(myBtc - electionBlock) > this.electionToleranceBlocks) return;
        let pubkeys = await this._getActiveOraclePublishPubkeys(electionBlock);
        if(!pubkeys.includes(myPubkey)) return;
        if(pubkeys.length > 1 &&
           sender !== StateAnchorPublisher.hashOrder(this._archiveElectionKey(electionBlock), pubkeys)[0])
            return;                                                          // not the elected archive leader

        let canonical = this._archiveCanonical(cp, Number(d.batch_seq), Number(d.match_count),
                                               String(d.batch_crc32), Number(d.total_chunks));
        if(!ValidatorIdentity.verify(canonical, String(d.sig || ''), sender)) return;

        // 1. The checkpoint wrapper must equal OUR state_checkpoints row (latest
        // seq for the height — a reorg-superseded row never co-signs an archive).
        let local = await this.db.doQuery(
            'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ? ORDER BY checkpoint_seq DESC LIMIT 1',
            [cp.chain, cp.network, Number(cp.block_index)]);
        if(!local || local.length === 0) return;
        let mine = this._cpFromRow(local[0]);
        if(StateCheckpointEngine.canonicalCheckpoint(mine) !== StateCheckpointEngine.canonicalCheckpoint(cp)) return;

        // 2. The archive must decompress, CRC-match, and byte-match our own rows.
        let json;
        try { json = zlib.gunzipSync(Buffer.from(String(d.archive_b64), 'base64url')).toString('utf8'); }
        catch(e){ return; }
        if(this._crc32Hex(json) !== String(d.batch_crc32)) return;
        let archive;
        try { archive = JSON.parse(json); } catch(e){ return; }
        if(!archive || !Array.isArray(archive.matches) || archive.matches.length !== Number(d.match_count)) return;
        if(!(await this._verifyArchiveAgainstLocal(archive))){
            console.warn('StateAnchorPublisher: proposed archive (batch ' + d.batch_seq + ') diverges from our DB — NOT signing');
            return;
        }

        this.peerManager.broadcast(XANC_SIGN, {
            batch_seq: Number(d.batch_seq), sig_pubkey: myPubkey, sig: this.identity.sign(canonical)
        });
    }

    // Every archived match's TERMS must byte-equal our own cross_chain_matches
    // row (every hub writes finalized matches, so the local DB is authoritative).
    // validator_signatures is EXCLUDED from the byte-comparison — each hub stores
    // its own collected sig set (membership/order differ per node) — and instead
    // verified CRYPTOGRAPHICALLY: the archived sigs must reach 2f+1 of OUR OWN
    // resolved cross_chain set over the XMATCH canonical (strictly stronger than
    // comparing local copies). Capability sets must exactly equal our own
    // resolution — set equality, not subset, so a leader can neither inject a
    // fake validator nor omit a real one.
    async _verifyArchiveAgainstLocal(archive){
        for(let am of archive.matches){
            let rows = await this.db.doQuery('SELECT * FROM cross_chain_matches WHERE match_id = ? LIMIT 1', [am.match_id]);
            if(rows && rows.length > 0){
                let localTerms    = StateAnchorPublisher.serializeMatch(rows[0]);
                let archivedTerms = Object.assign({}, am);
                // id is per-hub bookkeeping (each hub assigns its own AUTO_INCREMENT
                // cursor) — the leader archives ITS id as the recovery ordering key, so
                // followers must not byte-compare it, like validator_signatures.
                delete localTerms.id;
                delete archivedTerms.id;
                delete localTerms.validator_signatures;
                delete archivedTerms.validator_signatures;
                if(JSON.stringify(localTerms) !== JSON.stringify(archivedTerms)){
                    console.warn("StateAnchorPublisher: archive match " + String(am.match_id).substring(0, 16) +
                                 "... TERMS differ from our row — local " + JSON.stringify(localTerms).substring(0, 120) +
                                 " vs archived " + JSON.stringify(archivedTerms).substring(0, 120));
                    return false;
                }
            } else {
                // A row we never wrote: it predates this hub joining the
                // federation (a late joiner has no copy of earlier history).
                // The cryptographic bar below — archived sigs reaching 2f+1 of
                // OUR OWN resolved cross_chain set at the row's snapshot_block —
                // is the same proof full-parse recovery accepts, so absence is
                // not divergence. A forged row cannot carry those signatures.
                console.log('StateAnchorPublisher: archive match ' + String(am.match_id).substring(0, 16) +
                            '... predates our local history — accepting on signature quorum alone');
            }

            let set  = await this._resolveCapabilitySet('cross_chain', Number(am.snapshot_block));
            let sigs = this._parseSigs(am.validator_signatures);
            if(!this._quorumVerified(this._matchCanonical(am), sigs, set.map(v => v.pubkey))){
                console.warn('StateAnchorPublisher: archive match ' + String(am.match_id).substring(0, 16) +
                             '... fails signature quorum against the cross_chain set at block ' + am.snapshot_block);
                return false;
            }
        }
        for(let ac of (archive.calls || [])){
            let rows = await this.db.doQuery(
                'SELECT * FROM cross_chain_calls WHERE call_id = ? AND phase = ? LIMIT 1', [ac.call_id, ac.phase]);
            if(rows && rows.length > 0){
                let localTerms    = StateAnchorPublisher.serializeCall(rows[0]);
                let archivedTerms = Object.assign({}, ac);
                delete localTerms.id;                       // per-hub cursor — see the match loop
                delete archivedTerms.id;
                delete localTerms.validator_signatures;
                delete archivedTerms.validator_signatures;
                if(JSON.stringify(localTerms) !== JSON.stringify(archivedTerms)){
                    console.warn("StateAnchorPublisher: archive call " + String(ac.call_id).substring(0, 16) +
                                 "... (" + ac.phase + ") TERMS differ from our row — local " + JSON.stringify(localTerms).substring(0, 160) +
                                 " vs archived " + JSON.stringify(archivedTerms).substring(0, 160));
                    return false;
                }
            } else {
                console.log('StateAnchorPublisher: archive call ' + String(ac.call_id).substring(0, 16) +
                            '... (' + ac.phase + ') predates our local history — accepting on signature quorum alone');
            }

            let set  = await this._resolveCapabilitySet('cross_chain', Number(ac.snapshot_block));
            let sigs = this._parseSigs(ac.validator_signatures);
            if(!this._quorumVerified(this._callCanonical(ac), sigs, set.map(v => v.pubkey))){
                console.warn('StateAnchorPublisher: archive call ' + String(ac.call_id).substring(0, 16) +
                             '... (' + ac.phase + ') fails signature quorum against the cross_chain set at block ' + ac.snapshot_block);
                return false;
            }
        }
        let groups = new Map();              // block|capability → Map<pubkey, amount>
        for(let s of (archive.capability_snapshots || [])){
            let key = Number(s.snapshot_block) + '|' + String(s.capability);
            if(!groups.has(key)) groups.set(key, new Map());
            groups.get(key).set(String(s.signing_pubkey).toLowerCase(), String(s.amount));
        }
        for(let [key, archived] of groups){
            let [block, capability] = key.split('|');
            let resolved = await this._resolveCapabilitySet(capability, Number(block));
            if(resolved.length !== archived.size){
                console.warn("StateAnchorPublisher: archive snapshot group " + key + " size " + archived.size +
                             " differs from our resolution (" + resolved.length + ")");
                return false;
            }
            for(let v of resolved){
                if(!archived.has(v.pubkey) || archived.get(v.pubkey) !== v.amount){
                    console.warn("StateAnchorPublisher: archive snapshot group " + key + " diverges for pubkey " +
                                 v.pubkey.substring(0, 12) + "... (local amount " + v.amount + ", archived " +
                                 (archived.get(v.pubkey) || "<absent>") + ")");
                    return false;
                }
            }
        }
        return true;
    }

    // Leader: collect archive co-signatures.
    async _handleSign(envelope){
        let d = envelope.data;
        let round = this._archiveRound;
        if(!round || round.done || Number(d.batch_seq) !== round.batchSeq) return;
        let pubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!round.validators.includes(pubkey)) return;
        if(!ValidatorIdentity.verify(round.canonical, String(d.sig || ''), pubkey)) return;
        round.signatures.set(pubkey, String(d.sig));
        await this._checkArchiveQuorum();
    }

    async _checkArchiveQuorum(){
        let round = this._archiveRound;
        if(!round || round.done || round.signatures.size < round.quorum) return;
        round.done = true;
        if(round.timer){ clearTimeout(round.timer); round.timer = null; }
        this._archiveRound = null;
        await this._publishArchive(round);
        this._pendingMatches = 0;
    }

    // Build + broadcast the v1 (+v2 continuations), then back-fill and tell peers.
    async _publishArchive(round){
        let sigs = [];
        for(let [pk, sg] of round.signatures) sigs.push({ pubkey: pk, sig: sg });

        let cp = round.cp;
        let parts = ['ANCHOR', '1', cp.chain, cp.network, String(cp.block_index), cp.block_hash,
                     cp.ledger_hash, cp.actions_hash, cp.contract_hash,
                     String(cp.checkpoint_seq), String(cp.snapshot_block),
                     String(round.batchSeq), String(round.count), round.crc,
                     String(round.chunks.length), round.chunks[0], String(sigs.length)];
        for(let s of sigs) parts.push(s.pubkey, s.sig);
        let v1Payload = parts.join('|');

        let broadcaster = round.signer.broadcastFn || ((p) => this._defaultBroadcast(p, round.signer));
        let result = await broadcaster(v1Payload);
        let txid = result && result.txid ? result.txid : null;

        let lostChunks = 0;
        for(let i = 1; i < round.chunks.length; i++){
            let v2Payload = ['ANCHOR', '2', String(round.batchSeq), String(i), String(round.chunks.length), round.chunks[i]].join('|');
            // Back-to-back chunk spends race the UTXO tracker's mempool view and
            // collide on input selection (txn-mempool-conflict). A lost chunk is
            // a DURABILITY failure — recovery needs every chunk — so retry with a
            // pause for the previous spend to become visible before giving up.
            let sent = false, lastErr = null;
            for(let attempt = 0; attempt < 5 && !sent; attempt++){
                if(attempt > 0) await new Promise(r => setTimeout(r, this.chunkRetryDelayMs));
                try { await broadcaster(v2Payload); sent = true; }
                catch(e){ lastErr = e; }
            }
            if(!sent){
                lostChunks++;
                console.error('StateAnchorPublisher: v2 chunk ' + i + ' broadcast failed after retries: ' + (lastErr && lastErr.message));
            }
        }

        // A partially-published archive is unrecoverable (recovery refuses
        // incomplete batches), so the rows must NOT be marked archived. Back-fill
        // with a sentinel archived_status instead: batch_seq still advances (a
        // re-archive must get a FRESH seq — two v1 anchors sharing one seq would
        // corrupt chunk reassembly) while `archived_status <> status` keeps every
        // row eligible, so the next flush re-archives the whole batch.
        let matchIds = round.matchIds, callIds = round.callIds || [];
        if(lostChunks > 0){
            matchIds = matchIds.map(m => Object.assign({}, m, { status: '__partial__' }));
            callIds  = callIds.map(c => Object.assign({}, c, { status: '__partial__' }));
            console.error('StateAnchorPublisher: batch ' + round.batchSeq + ' lost ' + lostChunks +
                          ' chunk(s) on-chain — rows stay pending; they re-archive under a new batch seq');
        }
        await this._backfillBatch(round.batchSeq, matchIds, txid, callIds);
        if(this.peerManager){
            this.peerManager.broadcast(XANC_FINALIZED, {
                batch_seq: round.batchSeq, txid: txid, matches: matchIds,
                calls: callIds,
                sig_pubkey: this.identity.getPubkeyHex().toLowerCase(),
                sig: this.identity.sign(this._finalizedCanonical(round.batchSeq, txid, matchIds.length))
            });
        }
        if(lostChunks === 0){
            console.log('StateAnchorPublisher: archived ' + round.count + ' matches + ' +
                        ((round.callIds && round.callIds.length) || 0) + ' calls (batch ' + round.batchSeq +
                        ', ' + round.chunks.length + ' chunk(s), txid ' + txid + ')');
            this._recordReward('anchor_archive', round.batchSeq, round.electionBlock);
        }
    }

    // Peers back-fill batch metadata so a rotated leader doesn't re-archive.
    async _handleFinalized(envelope){
        let d = envelope.data;
        if(!d || !Array.isArray(d.matches)) return;
        let sender = String(d.sig_pubkey || '').toLowerCase();
        let pubkeys = await this._getActiveOraclePublishPubkeys(null);
        if(pubkeys.length && !pubkeys.includes(sender)) return;
        if(!ValidatorIdentity.verify(this._finalizedCanonical(Number(d.batch_seq), d.txid, d.matches.length),
                                     String(d.sig || ''), sender)) return;
        await this._backfillBatch(Number(d.batch_seq), d.matches, d.txid ? String(d.txid) : null,
                                  Array.isArray(d.calls) ? d.calls : []);
    }

    _finalizedCanonical(batchSeq, txid, count){
        return 'XANCFIN|' + String(batchSeq) + '|' + String(txid || '') + '|' + String(count);
    }

    // XMATCH canonical — byte-identical to CrossChainDexEngine._canonicalMatch /
    // the indexer's cross_settle._canonical (kept local so archive verification
    // never depends on the DEX engine being constructed).
    _matchCanonical(m){
        return [
            'XMATCH', m.match_id, String(m.snapshot_block),
            m.a_chain, String(m.a_action_index), m.a_tick || '', String(m.a_amount), String(m.a_ownership), m.a_payout_addr,
            m.b_chain, String(m.b_action_index), m.b_tick || '', String(m.b_amount), String(m.b_ownership), m.b_payout_addr,
            String(m.effective_time), m.network || '',
            m.a_kind || 'swap', String(m.a_filled_before != null ? m.a_filled_before : '0'),
            m.b_kind || 'swap', String(m.b_filled_before != null ? m.b_filled_before : '0')
        ].join('|');
    }

    // XCALL phase canonicals — byte-identical to CrossChainCallEngine._canonicalMatch
    // / the indexer's verifiers (kept local for the same reason as _matchCanonical).
    _callCanonical(c){
        let sha = (s) => crypto.createHash('sha256').update(String(s == null ? '' : s), 'utf8').digest('hex');
        if(c.phase === 'result'){
            return [
                'XCALL', 'RESULT', c.call_id, String(c.snapshot_block), c.network || '',
                c.target_chain, String(c.result_status || ''),
                sha(c.return_payload_b64), String(c.effective_time)
            ].join('|');
        }
        return [
            'XCALL', 'DISPATCH', c.call_id, String(c.snapshot_block), c.network || '',
            c.source_chain, String(c.source_action_index), String(c.source_contract_index),
            c.target_chain, String(c.target_contract_index),
            c.method, sha(c.params_json),
            String(c.gas_limit), String(c.cross_hops), String(c.effective_time)
        ].join('|');
    }

    _quorumVerified(canonical, sigs, pubkeys){
        let qualified = new Set((pubkeys || []).map(p => String(p).toLowerCase()));
        if(qualified.size === 0) return false;
        let quorum = (qualified.size <= 1) ? 1 : Math.max(2 * Math.floor((qualified.size - 1) / 3) + 1, Math.ceil((qualified.size + 1) / 2));
        let valid = 0, seen = new Set();
        for(let s of sigs){
            let pk = String(s.pubkey).toLowerCase();
            if(seen.has(pk) || !qualified.has(pk)) continue;
            seen.add(pk);
            if(ValidatorIdentity.verify(canonical, String(s.sig), pk)) valid++;
        }
        return valid >= quorum;
    }

    async _backfillBatch(batchSeq, matchIds, txid, callIds){
        for(let m of matchIds){
            await this.db.doQuery(
                'UPDATE cross_chain_matches SET batch_seq = ?, archived_status = ?, anchor_txid = COALESCE(?, anchor_txid) WHERE match_id = ?',
                [batchSeq, m.status, txid, m.match_id]);
        }
        for(let c of (callIds || [])){
            await this.db.doQuery(
                'UPDATE cross_chain_calls SET batch_seq = ?, archived_status = ?, anchor_txid = COALESCE(?, anchor_txid) WHERE call_id = ? AND phase = ?',
                [batchSeq, c.status, txid, c.call_id, c.phase]);
        }
    }

    async _getNextBatchSeq(){
        let r = await this.db.doQuery(
            'SELECT COALESCE(GREATEST(' +
            '  COALESCE((SELECT MAX(batch_seq) FROM cross_chain_matches), -1), ' +
            '  COALESCE((SELECT MAX(batch_seq) FROM cross_chain_calls), -1)' +
            '), -1) + 1 AS next_seq');
        return (r && r.length > 0) ? Number(r[0].next_seq) : 0;
    }

    _cpFromRow(row){
        return {
            chain: String(row.chain), network: String(row.network), block_index: Number(row.block_index),
            block_hash: String(row.block_hash), ledger_hash: String(row.ledger_hash),
            actions_hash: String(row.actions_hash), contract_hash: String(row.contract_hash),
            checkpoint_seq: Number(row.checkpoint_seq), snapshot_block: Number(row.snapshot_block)
        };
    }

    _parseSigs(raw){
        try {
            let sigs = JSON.parse(String(raw || '[]'));
            return Array.isArray(sigs) ? sigs.filter(s => s && s.pubkey && s.sig) : [];
        } catch(e){ return []; }
    }

    // crc32 over the UNCOMPRESSED archive JSON (zlib version independent).
    _crc32Hex(str){
        let n = zlib.crc32 ? zlib.crc32(Buffer.from(str, 'utf8')) : this._crc32Fallback(Buffer.from(str, 'utf8'));
        return (n >>> 0).toString(16).padStart(8, '0');
    }
    _crc32Fallback(buf){
        let c, crc = 0xFFFFFFFF;
        for(let i = 0; i < buf.length; i++){
            c = (crc ^ buf[i]) & 0xFF;
            for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            crc = (crc >>> 8) ^ c;
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    // ── Eligible set + DOGE pipeline (mirror OraclePublisher) ──────────────────
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

    _resolveSigner(){
        let op = this.hub.oraclePublisher || {};
        return {
            broadcastFn:  this.broadcastFn  || op.broadcastFn  || null,
            walletSignFn: this.walletSignFn || op.walletSignFn || null,
            getBalanceFn: this.getBalanceFn || op.getBalanceFn || null,
            encoder:      this.encoder      || op.encoder      || null
        };
    }

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
            console.warn('StateAnchorPublisher: DOGE balance LOW (' + Number(balance).toFixed(4) + ' DOGE)');
        return balance;
    }
}

module.exports = StateAnchorPublisher;
module.exports.XANC_SIGN_REQ  = XANC_SIGN_REQ;
module.exports.XANC_SIGN      = XANC_SIGN;
module.exports.XANC_FINALIZED = XANC_FINALIZED;
module.exports.XANC_V0_DONE   = XANC_V0_DONE;
module.exports.MATCH_KEYS     = MATCH_KEYS;
