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
 * XChain Hub - ROLLCALL round (validator liveness presence proof)
 *
 * Every validator signs a canonical bound to a BITCOIN epoch block's
 * `ledger_hash`, gossips the signature, and an elected leader lands the
 * collected signatures on DOGECOIN as a ROLLCALL action. The BTC indexer closes
 * the epoch, proves the DOGE roll call, and evicts sources that were absent for
 * K consecutive rolled epochs.
 *
 * Binding the message to `ledger_hash(E)` is the whole liveness claim: it cannot
 * be signed before the epoch block is mined, so a valid signature shows the key
 * was operating with a synced view of BTC inside the accept window. A pre-signed
 * stack of future heartbeats is impossible.
 *
 * NOTHING HERE IS CONSENSUS. This engine decides only WHEN and BY WHOM an action
 * is published. Which signatures count, which epochs exist, who is absent and
 * who is evicted is decided BTC-side at the epoch close, which re-verifies every
 * signature against its OWN ledger_hash. So the hub applies no stake floor and
 * computes no quorum: it verifies each signature cryptographically, keeps the
 * signers that are in its own whole-federation snapshot, and stops. Its set is
 * advisory and a superset of the chain's responsible set.
 *
 * Shape borrowed, deliberately, from two neighbours:
 *   - FullNodeChallengeRound: the sign-and-gossip skeleton, the abstain-on-
 *     unresolved-snapshot branch, and the durable spend-intent record that makes
 *     a restart unable to double-publish.
 *   - StateAnchorPublisher: hashOrder election, the rank-unlock failover ladder,
 *     SpendGuard, the DOGE_LOW_BALANCE_THRESHOLD floor, and the borrowed DOGE
 *     signer (_resolveSigner).
 *
 * FOUR PUBLISH ROLES, one job each:
 *   rank 0 (leader)  publishes EVERY rolled epoch; the publish reward attaches
 *                    to it and to nobody else, so this is the rational policy
 *                    and not an "on demand" one that no chain rule could enforce.
 *   ranks 1..n       sweepers, unlocking one ROLLCALL_ELECTION_TOLERANCE_BLOCKS
 *                    apart, publishing only what the ranks before them left out.
 *                    This is the LIVENESS failover: a dead or censoring leader
 *                    costs the epoch nothing while one honest eligible hub is up,
 *                    and it is why a validator with no DOGE wallet still gets
 *                    rolled.
 *   self-publish     a hub whose OWN signature is not on chain by
 *                    E + ROLLCALL_SELF_PUBLISH_BLOCKS lands a one-signature roll
 *                    call itself. This is the CENSORSHIP escape hatch, not the
 *                    liveness failover.
 *
 * An inert federation (no elected key whose hub can publish, or every publisher
 * wallet under the balance floor) publishes nothing: every epoch closes unrolled,
 * nobody is evicted, and the unrolled-epochs monitor is the detector. That is
 * correct behaviour, not an error path.
 *
 * A ROLLCALL is always a two-phase P2SH publish (the header alone is past the
 * 80-byte OP_RETURN limit), and the built-in encoder pipeline fails closed on
 * P2SH, so this engine publishes ONLY through a signer module that exports
 * `broadcast(payload)`. A hand-built module exporting just `walletSign` can sign
 * roll calls and never publish one; `getrollcallstatus.broadcast_capable` and the
 * oracle_publish self-test both say so rather than leaving it silent.
 *
 ********************************************************************/

'use strict';

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const ValidatorIdentity          = require('./ValidatorIdentity.js');
const EncoderClient              = require('./EncoderClient.js');
const SpendGuard                 = require('./lib/spend_guard.js');
const StateAnchorPublisher       = require('./StateAnchorPublisher.js');
const { isAmbiguousSendError }   = require('./lib/idempotent_broadcast.js');
const { forwardableUtxos }       = require('./lib/encoder_utxo_forward.js');
const { assertSingleTxEncoding } = require('./lib/two_phase_guard.js');
const eq                         = require('./equivocation_header.js');
const rca                        = require('./rollcall_activation.js');
const { CANONICAL_REORG_BUFFER } = require('./snapshot_reorg_buffer.js');

// The one gossip type this engine adds. PeerManager.broadcast has no type
// registry, so a new type is this constant plus one `case` in _handleMessage.
const XROLLCALL_SIGN = 'XROLLCALL_SIGN';
// How many not-yet-opened epochs' gossip a hub holds. One is the normal case
// (peers a poll ahead); a few more covers a hub catching up after a stall.
const EARLY_SIG_EPOCHS = 4;

// Wire chunking bound, from the frozen test vector's size budget: a 7-digit
// epoch header costs 152 bytes and each (PUBKEY, SIG) pair 194, against the
// protocol's 8189-byte action-data ceiling. A federation larger than this is
// rolled in several actions per epoch, which the union rule makes free.
const MAX_PAIRS_PER_ACTION = 41;

// Per-network defaults for the three publish tunables. These are hub POLICY, not
// consensus: no §3.3/§3.4 chain rule reads any of them, which is why they live
// here and in CONFIGURATION.md rather than in rollcall_activation.js beside the
// values that decide what the ledger says.
//
// The ordering PUBLISH_DELAY < SELF_PUBLISH < ACCEPT_WINDOW - 24 is the part
// that binds (pinned by test/unit/RollcallRound.invariants.test.js): the 24 BTC
// blocks of margin cover the DOGE landing plus the two-hour miner timestamp
// slack, so a self-publish issued at the last moment still lands inside the
// accept window instead of arriving after the chain has stopped counting.
const PUBLISH_DELAY_DEFAULTS      = { mainnet: 12,  testnet: 12,  regtest: 1 };
// A SEPARATE knob from ANCHOR_ELECTION_TOLERANCE_BLOCKS on purpose: the two
// ladders climb against different anchors, and sharing one env would mean a
// roll-call cadence change could silently re-inert the anchor ladder.
const ELECTION_TOLERANCE_DEFAULTS = { mainnet: 36,  testnet: 36,  regtest: 3 };
// The regtest pair is 3 and 9, not the spec's first-draft 2 and 6, and the
// reason is that 6 collides with CANONICAL_REORG_BUFFER. A round cannot exist
// before tip - E >= 6, so at the very first tick a self-publish deadline of 6
// has ALREADY passed: every non-leader would self-publish immediately, the
// sweeper path would never run, and the rank ladder would never demonstrate
// the failover it exists to provide. Correctness is untouched either way (the
// union rule absorbs a duplicate), but the acceptance venue would be unable to
// show a sweeper filling a gap, which is one of the things it has to show. At
// 3 and 9 the first tick has ranks 0-1 unlocked and the deadline three blocks
// out, so sweep happens first and self-publish is the fallback it is meant to
// be. These are hub policy, not consensus: no chain rule reads them.
const SELF_PUBLISH_DEFAULTS       = { mainnet: 100, testnet: 100, regtest: 9 };

// How far past the accept window a finished round is kept in memory, so a late
// gossiped signature or a status read still finds it before it is pruned.
const ROUND_RETENTION_BLOCKS = 24;

class RollcallRound {

    constructor(hub){
        this.hub  = hub;
        let cfg   = (hub && hub.p2pConfig) || {};
        this.cfg  = cfg;
        this.peerManager        = hub && hub.peerManager;
        this.identity           = hub && hub.identity;
        this.capabilitySnapshot = hub && hub.capabilitySnapshot;
        this.network            = (hub && hub.network) || cfg.HUB_NETWORK || '';

        // CONSENSUS constants come from the byte-identical twin of the indexer's
        // rollcall_activation.js and have no env surface at all. Reading any of
        // them from the environment would let one hub sign for epochs another
        // hub does not believe exist.
        this.interval     = rca.ROLLCALL_INTERVAL_BLOCKS[this.network];
        this.acceptWindow = rca.ROLLCALL_ACCEPT_WINDOW_BLOCKS[this.network];

        // Operational knobs: this hub's own timing and participation only.
        this.enabled = String(process.env.ROLLCALL_ENABLED || cfg.ROLLCALL_ENABLED || 'true') !== 'false';
        this.pollMs  = parseInt(process.env.ROLLCALL_POLL_MS || cfg.ROLLCALL_POLL_MS || '30000');

        this.publishDelayBlocks      = this._resolveTunable('ROLLCALL_PUBLISH_DELAY_BLOCKS',      PUBLISH_DELAY_DEFAULTS);
        this.electionToleranceBlocks = this._resolveTunable('ROLLCALL_ELECTION_TOLERANCE_BLOCKS', ELECTION_TOLERANCE_DEFAULTS);
        this.selfPublishBlocks       = this._resolveTunable('ROLLCALL_SELF_PUBLISH_BLOCKS',       SELF_PUBLISH_DEFAULTS);

        // BTC indexer (ledger_hash + tip) and DOGE indexer (what is already on
        // chain for the epoch). Same env surface the rest of the hub uses.
        this.indexerUrl = process.env.BTC_INDEXER_URL || cfg.BTC_INDEXER_URL || '';
        this.indexerKey = process.env.BTC_INDEXER_API_KEY || cfg.BTC_INDEXER_API_KEY || '';
        this.dogeIndexerUrl = process.env.DOGE_INDEXER_API_URL || process.env.DOGE_INDEXER_URL ||
                              cfg.DOGE_INDEXER_URL || '';
        this.dogeIndexerKey = process.env.DOGE_INDEXER_API_KEY || cfg.DOGE_INDEXER_API_KEY || '';

        // DOGE publish rail, identical to the anchor rail's: same address, same
        // encoder, same balance floor. Hooks left null here are borrowed from the
        // price publisher at send time (_resolveSigner).
        this.dogeAddress = process.env.DOGE_ADDRESS || cfg.DOGE_ADDRESS || '';
        let encoderUrl   = process.env.DOGE_ENCODER_URL || cfg.DOGE_ENCODER_URL || '';
        let encoderKey   = process.env.DOGE_ENCODER_API_KEY || cfg.DOGE_ENCODER_API_KEY || '';
        this.encoder     = encoderUrl ? new EncoderClient(encoderUrl, encoderKey) : null;
        this.broadcastFn  = null;
        this.walletSignFn = null;
        this.getBalanceFn = null;

        this.lowBalanceThreshold = parseFloat(process.env.DOGE_LOW_BALANCE_THRESHOLD || cfg.DOGE_LOW_BALANCE_THRESHOLD || '10');
        this.spendGuard = new SpendGuard('ROLLCALL', cfg, 'RollcallRound');
        this.spendGuard.minBalance = this.lowBalanceThreshold;

        // Durable spend audit for the fee-bearing publish, the shape every other
        // hub effector uses. The intent line is written and fsync'd BEFORE the
        // money moves and the broadcast is gated on it, so a crash mid-flight
        // still leaves a recoverable trace that DOGE may have been spent.
        this.spendLogPath = process.env.ROLLCALL_SPEND_LOG_PATH || cfg.ROLLCALL_SPEND_LOG_PATH ||
                            './data/rollcall-publish.spend.jsonl';
        // Durable signature store. A restart inside the accept window must
        // re-emit the SAME signature rather than mint a second one: the epoch's
        // ledger_hash is fixed, so a fresh signature would be redundant gossip,
        // and a hub whose indexer has gone dark since would otherwise fall silent
        // for an epoch it had already answered.
        this.signLogPath = process.env.ROLLCALL_SIGN_LOG_PATH || cfg.ROLLCALL_SIGN_LOG_PATH ||
                           './data/rollcall-signatures.jsonl';

        this.rounds       = new Map();   // epoch -> round state
        this._signatures  = new Map();   // epoch -> { ledgerHash, sig } recovered from disk
        // Gossip that arrived for an epoch this hub has not opened yet. A peer
        // broadcasts its signature ONCE, when it signs, and never again; a hub
        // that ticks later would otherwise lose every earlier signer for good
        // and lead with a partial set. Drained into the round when it opens.
        this._earlySigs   = new Map();   // epoch -> Map(pubkey -> sig)
        // Epochs whose publish fee a PRIOR process already committed, and the
        // separate self-publish commitments. The rounds map is empty after a
        // restart, so it cannot answer either question.
        this._committed     = new Set();  // key: <epoch> | <epoch>:self
        this._timer         = null;
        this._ticking       = false;
        this._loggedNoBroadcast = false;
        this._handler       = (env) => this._handleMessage(env);
    }

    // Env, then p2pConfig, then the per-network default. Garbage or a negative
    // value falls back to the default rather than disabling the gate it feeds:
    // a NaN publish delay would compare false forever and publish nothing, which
    // is exactly the silent inertness this engine must not have.
    _resolveTunable(name, defaults){
        let fallback = defaults[this.network];
        if(!Number.isFinite(fallback)) fallback = defaults.mainnet;
        let raw = process.env[name] !== undefined ? process.env[name] : this.cfg[name];
        if(raw === undefined || raw === null || raw === '') return fallback;
        let n = parseInt(raw, 10);
        if(!Number.isFinite(n) || n < 0){
            console.warn('RollcallRound: ' + name + ' "' + raw + '" is not a non-negative integer; ' +
                         'using the ' + this.network + ' default (' + fallback + ')');
            return fallback;
        }
        return n;
    }

    // Standard publisher setters, so signer-loader's applySignerHooks wires this
    // engine exactly as it wires the price and anchor publishers.
    setBroadcastHook(fn){  this.broadcastFn  = fn; }
    setWalletSignHook(fn){ this.walletSignFn = fn; }
    setBalanceHook(fn){    this.getBalanceFn = fn; }
    setEncoder(enc){       this.encoder      = enc; }

    async start(){
        if(!this.enabled){
            console.log('RollcallRound: disabled');
            return;
        }
        if(!Number.isFinite(this.interval) || this.interval <= 0){
            console.warn('RollcallRound: no ROLLCALL_INTERVAL_BLOCKS for network ' +
                         JSON.stringify(this.network) + '; the engine stays idle');
            return;
        }
        // Do not start on a network whose activation height is the INERT
        // placeholder. Every epoch would fail isRollcallActive and the tick would
        // do nothing, but it would still poll the BTC indexer forever, and on a
        // hub with no BTC indexer configured (which is every mainnet hub today,
        // since nothing there needs one yet) each of those polls throws and logs.
        // A feature the operator has not armed should cost nothing and say
        // nothing, not emit a recurring warning that reads as a fault.
        let armedAt = rca.ROLLCALL_ACTIVATION[this.network];
        if(!Number.isFinite(armedAt)){
            console.log('RollcallRound: inert on ' + JSON.stringify(this.network) +
                        ' (no activation height set); the engine stays idle');
            return;
        }
        if(this.peerManager) this.peerManager.on('message', this._handler);
        // Both logs must be consumed BEFORE the first tick: the recovered epochs
        // gate the very round that tick reconstructs.
        this._loadSignLog();
        this._loadSpendLog();
        this.spendGuard.persistTo();
        let tick = async () => {
            try { await this._tick(); }
            catch(e){ console.warn('RollcallRound tick:', e && e.message ? e.message : e); }
        };
        this._timer = setInterval(tick, this.pollMs);
        await tick();
        console.log('RollcallRound started (interval=' + this.interval + ' blocks, window=' + this.acceptWindow +
                    ', publish delay=' + this.publishDelayBlocks + ', ladder step=' + this.electionToleranceBlocks +
                    ', self-publish=' + this.selfPublishBlocks +
                    ', broadcast=' + (this.broadcastCapable() ? 'yes' : 'NO (sign-and-gossip only)') + ', ' +
                    this._signatures.size + ' signature(s) recovered)');
    }

    async stop(){
        if(this._timer) clearInterval(this._timer);
        this._timer = null;
        if(this.peerManager) this.peerManager.removeListener('message', this._handler);
    }

    // ── canonical + wire ─────────────────────────────────────────────────────

    // CONSENSUS-CRITICAL: must byte-match what xchain-indexer's actions/rollcall.js
    // rebuilds from the carried fields and what the BTC close rebuilds from its own
    // ledger_hash. Frozen by xchain-documentation/protocol/test-vectors/rollcall_canonical.json.
    //
    // Every ROLLCALL that can exist is at or above EQUIV_HEADER_ACTIVATION, so only
    // the wrapped form is ever built; the bare headerless form has no producer.
    _canonical(epochHeight, ledgerHash){
        let content = String(this.network) + '|' + Number(epochHeight) + '|' + String(ledgerHash).toLowerCase();
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.ROLLCALL, String(Number(epochHeight)), 0, content);
    }

    // ROLLCALL|0|EPOCH_HEIGHT|LEDGER_HASH|PUBLISHER|SIG_COUNT|PUBKEY_1|SIG_1|...
    //
    // PUBLISHER carries no signature of its own; it is the key the publish reward
    // attaches to, and the chain pays only the ELECTED leader, so naming a key
    // here is a claim the close checks rather than a race anyone can win.
    _buildWire(epochHeight, ledgerHash, publisher, pairs){
        let parts = ['ROLLCALL', '0', String(Number(epochHeight)),
                     String(ledgerHash).toLowerCase(), String(publisher).toLowerCase(),
                     String(pairs.length)];
        for(let p of pairs) parts.push(String(p.pubkey).toLowerCase(), String(p.sig).toLowerCase());
        return parts.join('|');
    }

    // Split a pair list into per-action chunks. Any number of ROLLCALLs may land
    // for one epoch and the present set is their UNION, so a split costs a second
    // fee and nothing else.
    static chunkPairs(pairs, max){
        let size = Number.isFinite(max) && max > 0 ? max : MAX_PAIRS_PER_ACTION;
        let out = [];
        for(let i = 0; i < pairs.length; i += size) out.push(pairs.slice(i, i + size));
        return out;
    }

    // ── indexer transports ───────────────────────────────────────────────────

    async _indexerCall(method, params){
        let url = this.indexerUrl;
        if(this.hub && typeof this.hub._resolveBtcIndexerUrl === 'function'){
            try { url = (await this.hub._resolveBtcIndexerUrl()) || this.indexerUrl; } catch(_){}
        }
        if(!url) throw new Error('no BTC indexer URL (set BTC_INDEXER_API_URL / BTC_INDEXER_URL)');
        let headers = (this.hub && typeof this.hub._btcIndexerHeaders === 'function')
            ? this.hub._btcIndexerHeaders()
            : Object.assign({ 'Content-Type': 'application/json' }, this.indexerKey ? { 'x-api-key': this.indexerKey } : {});
        let resp = await axios.post(url, { jsonrpc: '2.0', method, params: params || {}, id: 1 }, { headers, timeout: 15000 });
        if(resp.data && resp.data.error) throw new Error('indexer RPC error: ' + JSON.stringify(resp.data.error));
        let result = resp.data ? resp.data.result : null;
        // The indexer reports failures in-band as result.error (a 200 carrying an
        // error object), not the JSON-RPC envelope, so gate on it here or a poll
        // error is returned as a valid result.
        if(result && result.error) throw new Error('indexer in-band error: ' + JSON.stringify(result.error));
        return result;
    }

    async _dogeIndexerCall(method, params){
        if(!this.dogeIndexerUrl) throw new Error('no DOGE indexer URL (set DOGE_INDEXER_API_URL / DOGE_INDEXER_URL)');
        let headers = { 'Content-Type': 'application/json' };
        if(this.dogeIndexerKey) headers['x-api-key'] = this.dogeIndexerKey;
        let resp = await axios.post(this.dogeIndexerUrl, { jsonrpc: '2.0', method, params: params || {}, id: 1 },
                                    { headers, timeout: 15000 });
        if(resp.data && resp.data.error) throw new Error('indexer RPC error: ' + JSON.stringify(resp.data.error));
        let result = resp.data ? resp.data.result : null;
        if(result && result.error) throw new Error('indexer in-band error: ' + JSON.stringify(result.error));
        return result;
    }

    // ── the tick ─────────────────────────────────────────────────────────────

    async _tick(){
        // In-flight guard, the house convention: a tick makes several sequential
        // RPC round trips at a 15s timeout against a 30s poll, so under a slow
        // indexer the next interval fires while this one is still awaiting, and
        // two overlapping ticks would both pass the rounds.has() test before
        // either reached rounds.set().
        if(this._ticking) return;
        this._ticking = true;
        try {
            let tip = await this._indexerCall('getblockhashes', {});
            let tipBlock = (tip && tip.block_index != null) ? Number(tip.block_index) : null;
            if(!Number.isFinite(tipBlock)) return;
            this.lastTip = tipBlock;

            let epoch = this.newestSignableEpoch(tipBlock);
            if(epoch !== null && !this.rounds.has(epoch)) await this._runEpoch(epoch, tipBlock);

            // Every open round advances on every tick, not just the newest: the
            // sweeper ladder and the self-publish escape hatch both unlock on the
            // tip moving away from an epoch that was created blocks ago.
            for(let [e, state] of this.rounds){
                if(tipBlock - e > this.acceptWindow + ROUND_RETENTION_BLOCKS){ this.rounds.delete(e); continue; }
                try { await this._advance(state, tipBlock); }
                catch(err){ console.warn('RollcallRound: epoch ' + e + ' advance failed:', err && err.message ? err.message : err); }
            }
        } finally {
            this._ticking = false;
        }
    }

    // The newest epoch boundary this hub may sign for at `tipBlock`: buried by
    // CANONICAL_REORG_BUFFER (signing for a block that can still be reorged out
    // would produce a signature over a ledger_hash nobody else ever sees) and
    // still inside the accept window (past it, no signature can land). Null when
    // no such epoch exists.
    //
    // Epoch 0 is a REAL epoch on regtest, so a falsy check on the height is a bug.
    newestSignableEpoch(tipBlock){
        if(!Number.isFinite(this.interval) || this.interval <= 0) return null;
        let epoch = Math.floor(tipBlock / this.interval) * this.interval;
        // The newest boundary may not be buried yet; step back one interval.
        if(tipBlock - epoch < CANONICAL_REORG_BUFFER) epoch -= this.interval;
        if(epoch < 0) return null;
        if(!rca.isRollcallEpoch(epoch, this.network)) return null;
        if(!rca.isRollcallActive(epoch, this.network)) return null;
        if(tipBlock - epoch > this.acceptWindow) return null;
        return epoch;
    }

    // ── sign + gossip ────────────────────────────────────────────────────────

    async _runEpoch(epoch, tipBlock){
        let bh = await this._indexerCall('getblockhashes', { block_index: epoch });
        let ledgerHash = (bh && bh.ledger_hash) ? String(bh.ledger_hash).toLowerCase() : '';
        if(!/^[0-9a-f]{64}$/.test(ledgerHash)){
            console.warn('RollcallRound: epoch=' + epoch + ' skipped (no ledger_hash from the BTC indexer)');
            return;
        }

        // The advisory member set: every staker with any active stake at the
        // epoch (CapabilitySnapshot buries the height itself, landing on the same
        // block the chain's responsible set resolves at). UNFLOORED and
        // capability-free on purpose, so it is a superset of the chain's R(E):
        // the chain decides membership, and a hub-side floor could only ever
        // discard a signature the chain would have counted.
        //
        // An unresolved snapshot (any indexer failure) makes this hub ABSTAIN for
        // the epoch rather than degrade to a partial set. A partial set is not a
        // smaller answer, it is a different one: this hub would drop honest peers'
        // signatures as outsiders and publish a roll call missing them, and an
        // absence is an eviction.
        let snap = await this.capabilitySnapshot.getActiveWeightSnapshot(epoch);
        if(!snap || !Array.isArray(snap.validators)){
            console.warn('RollcallRound: epoch=' + epoch + ' skipped (whole-federation snapshot unresolved; ' +
                         'ABSTAINING rather than collecting against a partial member set)');
            return;
        }
        let members = new Set();
        for(let v of snap.validators){
            let pk = String((v && v.pubkey) || v || '').toLowerCase();
            if(/^[0-9a-f]{64}$/.test(pk)) members.add(pk);
        }

        let canonical = this._canonical(epoch, ledgerHash);
        let myPubkey  = this.identity ? String(this.identity.getPubkeyHex()).toLowerCase() : null;

        let state = {
            epoch, ledgerHash, canonical, members,
            sigs:         new Map(),   // pubkey -> sig, deduped, verified
            signed:       false,
            order:        null,        // election order, resolved lazily at publish time
            leader:       null,
            myRank:       -1,
            published:    false,       // this hub has spent its per-epoch sweep publish
            selfPublished:false,
            ownSigOnWire: false,       // our own signature rode one of OUR broadcasts
            // Pubkeys this hub has actually put on the wire for this epoch, marked
            // per CHUNK rather than per batch. A multi-action publish that fails
            // half way releases its slot, and without this the retry rebuilds the
            // whole set and pays a second fee for signatures already broadcast.
            sent:         new Set(),
            onChainCount: null,        // last observed count from the DOGE read
            txids:        [],
            startedAt:    Date.now(),
        };
        this.rounds.set(epoch, state);

        // Sign. EVERY validator signs, wallet or not: the sweepers exist so a hub
        // with no DOGE wallet still gets rolled, so a wallet requirement here
        // would evict exactly the validators the sweepers were built to carry.
        if(myPubkey){
            let stored = this._signatures.get(epoch);
            let sig;
            if(stored && stored.ledgerHash === ledgerHash){
                // Restart re-emit: the same signature, not a fresh one.
                sig = stored.sig;
            } else {
                sig = this.identity.sign(canonical);
                this._recordSignature({ epoch, pubkey: myPubkey, ledger_hash: ledgerHash, sig });
                this._signatures.set(epoch, { ledgerHash, sig });
            }
            state.signed = true;
            // Our own signature goes through the same membership rule as a peer's,
            // so the collected set has one definition rather than two. A hub with
            // no active stake is in no responsible set and cannot be evicted.
            if(members.has(myPubkey)) state.sigs.set(myPubkey, sig);
            if(this.peerManager) this.peerManager.broadcast(XROLLCALL_SIGN, { epoch, pubkey: myPubkey, sig });
        }

        // Peers that signed before this hub opened the round: judged now, by the
        // same rule as a live message, and dropped from the holding area either way.
        let early = this._earlySigs.get(epoch);
        this._earlySigs.delete(epoch);
        for(let e of this._earlySigs.keys()) if(e < epoch) this._earlySigs.delete(e);
        if(early) for(let [pk, sig] of early) this._onSign({ epoch, pubkey: pk, sig });

        console.log('RollcallRound: epoch=' + epoch + ' ledger_hash=' + ledgerHash.substring(0, 16) +
                    '... members=' + members.size + ' signed=' + (state.signed ? 'yes' : 'no identity'));
    }

    // ── collect ──────────────────────────────────────────────────────────────

    _handleMessage(env){
        if(!env || !env.data) return;
        switch(env.type){
            case XROLLCALL_SIGN: return this._onSign(env.data);
        }
    }

    _onSign(d){
        let epoch = Number(d.epoch);
        let pk  = String(d.pubkey || '').toLowerCase();
        let sig = String(d.sig || '').toLowerCase();
        if(!Number.isFinite(epoch))      return;
        if(!/^[0-9a-f]{64}$/.test(pk))  return;
        if(!/^[0-9a-f]{128}$/.test(sig)) return;
        let state = this.rounds.get(epoch);
        if(!state){
            // Not opened here yet: hold it, unverified, for the round to judge.
            // Only epochs ahead of every open round are worth holding (an older
            // one can never open), and the holding area stays small.
            let newest = Math.max(-1, ...this.rounds.keys());
            if(epoch <= newest) return;
            let held = this._earlySigs.get(epoch) || new Map();
            if(!held.has(pk)) held.set(pk, sig);
            this._earlySigs.set(epoch, held);
            while(this._earlySigs.size > EARLY_SIG_EPOCHS)
                this._earlySigs.delete(Math.min(...this._earlySigs.keys()));
            return;
        }
        // Deduped by pubkey, and the key is only ever recorded once its signature
        // has verified: admitting a key on first sight would let a garbage pair
        // arriving before the real one suppress it, which reads downstream as an
        // absence and, over K epochs, evicts a validator that was demonstrably
        // present.
        if(state.sigs.has(pk)) return;
        // No floor and no quorum here (that is the chain's job, §3.4). The only
        // two questions are whether the signature is real and whether the signer
        // is in this hub's snapshot.
        if(!state.members.has(pk)) return;
        if(!ValidatorIdentity.verify(state.canonical, sig, pk)) return;
        state.sigs.set(pk, sig);
    }

    // ── elect ────────────────────────────────────────────────────────────────

    // The election key. Identical on every hub because both fields are chain-
    // derived, and STABLE while the tip advances, which is what makes the ladder
    // climbable: E is fixed, so `since` grows across the whole accept window and
    // floor(window / tolerance) ranks unlock inside it. The anchor ladder is inert
    // on the bundle rail only because a checkpoint's snapshot_block chases the tip.
    _electionKey(epoch){
        return 'XROLLCALL|' + this.network + '|' + String(epoch);
    }

    // The candidate set: effective keys of the oracle_publish capability set, the
    // SAME set the BTC close uses as R(E).
    //
    // The height passed is the RAW epoch. CapabilitySnapshot applies
    // CANONICAL_REORG_BUFFER itself (_buriedBlockIndex), so this resolves at
    // E - 6 = buriedSnapshotBlock(E, network), which is where the chain resolves
    // R(E). Passing an already-buried height here would bury twice and elect from
    // E - 12, forking the hub's leader from the one the close pays.
    //
    // Returns null when the set is unresolved, and every caller treats null as
    // abstain: an empty order would make _rankUnlocked false for everyone anyway,
    // but null says WHY, and it must never be read as "the federation is empty".
    async _electionOrder(epoch){
        let keys = null;
        try {
            let sap = this.hub && this.hub.stateAnchorPublisher;
            if(sap && typeof sap._resolveCapabilitySet === 'function'){
                // Borrowed rather than re-derived: the anchor rail already owns
                // the resolver that fails closed off regtest and picks the
                // source-keyed weighted form, and two copies of that logic would
                // be two ways to disagree with the chain.
                let set = await sap._resolveCapabilitySet('oracle_publish', epoch, this.network);
                if(Array.isArray(set)) keys = set.map(v => String(v.pubkey).toLowerCase());
            } else if(this.capabilitySnapshot && typeof this.capabilitySnapshot.getWeightSnapshot === 'function'){
                // The weighted form specifically: the chain's R(E) is
                // getStakeWeightsByCapability, which is source-keyed and carries
                // delegated effective keys the count form does not.
                let snap = await this.capabilitySnapshot.getWeightSnapshot('oracle_publish', epoch);
                if(snap && Array.isArray(snap.validators))
                    keys = snap.validators.map(v => String(v.pubkey).toLowerCase());
            }
        } catch(e){
            console.warn('RollcallRound: epoch=' + epoch + ' election set unresolved (' +
                         (e && e.message ? e.message : e) + '); abstaining from publishing');
            return null;
        }
        if(keys === null) return null;
        return StateAnchorPublisher.hashOrder(this._electionKey(epoch), keys);
    }

    // Rank 0 may publish immediately; each further rank unlocks after another
    // ROLLCALL_ELECTION_TOLERANCE_BLOCKS of BTC height past the epoch. Blocks, not
    // wall clock, so every hub computes the same unlock with no clock sync. A key
    // outside the order never publishes.
    _rankUnlocked(order, pubkey, sinceBlocks){
        if(!order) return false;
        let rank = order.indexOf(String(pubkey || '').toLowerCase());
        if(rank < 0) return false;
        if(rank === 0) return true;
        let unlocked = Number.isFinite(sinceBlocks)
            ? Math.floor(Math.max(0, sinceBlocks) / this.electionToleranceBlocks) : 0;
        return rank <= unlocked;
    }

    // ── publish ──────────────────────────────────────────────────────────────

    async _advance(state, tipBlock){
        let since = tipBlock - state.epoch;
        if(since > this.acceptWindow) return;       // nothing can land any more
        let myPubkey = this.identity ? String(this.identity.getPubkeyHex()).toLowerCase() : null;
        if(!myPubkey) return;

        if(state.order === null){
            let order = await this._electionOrder(state.epoch);
            if(order === null) return;              // unresolved: abstain, retry next tick
            state.order  = order;
            state.leader = order.length > 0 ? order[0] : null;
            state.myRank = order.indexOf(myPubkey);
        }

        await this._maybePublish(state, myPubkey, since);
        await this._maybeSelfPublish(state, myPubkey, since);
    }

    async _maybePublish(state, myPubkey, since){
        if(state.published) return;
        if(since < this.publishDelayBlocks) return;
        if(!this._rankUnlocked(state.order, myPubkey, since)) return;
        if(state.sigs.size === 0) return;
        if(!this._requireBroadcast()) return;

        let onChain = await this._onChainSigners(state);
        // Both branches below also exclude state.sent. Already on the wire from this
        // hub's own earlier chunks is the same answer as already on chain: the DOGE
        // read lags indexing by longer than a tick, so without it the retry after a
        // partial failure re-broadcasts, and re-pays for, every chunk that went out.
        let pairs;
        if(onChain === null){
            // The DOGE read is undecidable. The LEADER publishes anyway: its job
            // is to publish every epoch and at worst it pays a duplicate fee that
            // the union rule absorbs. A SWEEPER exists only to fill gaps, and one
            // that cannot see the gaps has nothing to add, so it defers to a later
            // tick rather than paying to re-publish what the leader already landed.
            if(state.myRank !== 0) return;
            pairs = Array.from(state.sigs, ([pubkey, sig]) => ({ pubkey, sig }))
                        .filter(p => !state.sent.has(p.pubkey));
        } else {
            pairs = Array.from(state.sigs, ([pubkey, sig]) => ({ pubkey, sig }))
                        .filter(p => !onChain.has(p.pubkey) && !state.sent.has(p.pubkey));
        }
        if(pairs.length === 0) return;

        state.published = true;   // one sweep publish per epoch per hub; see below
        let ok = await this._publishPairs(state, myPubkey, pairs, 'sweep');
        // A definitive failure releases the slot so a later tick can retry inside
        // the window, and the retry now rebuilds only the pairs that were never
        // broadcast. An ambiguous send does NOT release: the DOGE node may have
        // accepted the transaction, and re-broadcasting would burn the fee twice
        // for a roll call that is already landing.
        if(ok === 'retry') state.published = false;
    }

    async _maybeSelfPublish(state, myPubkey, since){
        if(state.selfPublished) return;
        if(since < this.selfPublishBlocks) return;
        let mySig = state.sigs.get(myPubkey);
        if(!mySig) return;                       // nothing of ours to rescue
        if(state.ownSigOnWire) return;           // our own publish already carried it
        if(!this._requireBroadcast()) return;

        let onChain = await this._onChainSigners(state);
        // Unresolved read: publish. This is the censorship escape hatch, and the
        // thing it escapes is precisely a federation whose answers cannot be
        // trusted; one extra transaction is cheaper than an eviction.
        if(onChain && onChain.has(myPubkey)) return;

        state.selfPublished = true;
        let ok = await this._publishPairs(state, myPubkey, [{ pubkey: myPubkey, sig: mySig }], 'self');
        if(ok === 'retry') state.selfPublished = false;
        if(ok === 'sent') state.ownSigOnWire = true;
    }

    // Broadcast one or more ROLLCALL actions carrying `pairs`. Returns 'sent',
    // 'retry' (a definitive failure; the caller may release its slot, and every
    // chunk that DID go out is recorded in state.sent so the retry rebuilds only
    // the undelivered tail) or 'held' (ambiguous; the slot stays claimed).
    async _publishPairs(state, myPubkey, pairs, kind){
        let key = kind === 'self' ? (state.epoch + ':self') : String(state.epoch);
        if(this._committed.has(key)){
            console.warn('RollcallRound: epoch ' + state.epoch + ' (' + kind + ') already carries a committed ' +
                         'publish spend in ' + this.spendLogPath + '; NOT re-broadcasting after restart');
            return 'held';
        }

        // Balance floor plus the runtime pause and the per-window spend ceiling,
        // checked BEFORE anything is built. A blocked publish is a deferral, not
        // a failure: an inert federation publishes nothing and every epoch closes
        // unrolled, which evicts nobody.
        // A balance source that THROWS reports null, not undefined: undefined means
        // "this hub wired no balance source and the floor is inert", while an
        // unreadable wallet must fail closed rather than look unconfigured.
        let balance;
        let signer = this._resolveSigner();
        if(signer.getBalanceFn){
            try { balance = await signer.getBalanceFn(); } catch(_){ balance = null; }
            if(balance === undefined) balance = null;
        }
        let g = this.spendGuard.check(balance === undefined ? {} : { balance });
        if(!g.ok){
            console.warn('RollcallRound: ' + g.reason + ' (epoch ' + state.epoch + ', ' + kind + '); deferring publish');
            return 'retry';
        }

        let chunks = RollcallRound.chunkPairs(pairs, MAX_PAIRS_PER_ACTION);

        // RESERVE one token per chunk, because one chunk is one transaction and one
        // fee. check() above is a PURE predicate read once for the whole batch, so on
        // its own an N-chunk roll call spends N fees against a single pre-send answer
        // and walks straight past the per-window ceiling by N-1. Reservation consumes
        // the budget in the same synchronous turn, which is the shape spend_guard.js
        // documents for an awaited send and the one AttestationBatchPublisher
        // ._broadcastWindow() already uses. check() STAYS: reserve() takes no balance
        // argument, so dropping it would silently retire the ROLLCALL_MIN_BALANCE
        // wallet floor.
        let tokens = [];
        for(let i = 0; i < chunks.length; i++){
            let token = this.spendGuard.reserve();
            if(!token){
                // Read the reason BEFORE releasing: giving the slots back first
                // re-opens the very gate that tripped, and the line then names a
                // ceiling that was never the one in the way.
                let why = this.spendGuard.noteBlocked();
                for(let t of tokens) this.spendGuard.release(t);
                console.warn('RollcallRound: ' + why + ' (epoch ' + state.epoch +
                             ', ' + kind + ', ' + chunks.length + ' chunk(s)); deferring publish');
                return 'retry';
            }
            tokens.push(token);
        }

        // Durable intent BEFORE the money moves and AFTER the reservation, and the
        // broadcast is GATED on it: an unwritable audit path must not let a real DOGE
        // fee be spent with no recoverable trace, and a batch the ceiling declined
        // must leave no orphan intent line behind.
        if(!this._recordSpend({ phase: 'intent', epoch: state.epoch, kind, pairs: pairs.length, chunks: chunks.length })){
            for(let t of tokens) this.spendGuard.release(t);
            console.error('RollcallRound: spend-audit path unwritable at ' + this.spendLogPath +
                          '; deferring the publish for epoch ' + state.epoch +
                          ' rather than spending a DOGE fee with no durable record');
            return 'retry';
        }
        this._committed.add(key);

        let result = 'sent';
        for(let i = 0; i < chunks.length; i++){
            // Re-read the operator pause before EVERY chunk. Each chunk is its own
            // awaited transaction and its own fee, and the pause is an out-of-band
            // runtime toggle (SpendGuard.pauseCapability from the control RPC), so a
            // pause landing while chunk i-1 is in flight has to stop the chunks that
            // have not gone out yet. Neither the pre-loop check() nor the reservations
            // can see it: both were taken in one earlier synchronous turn. Every
            // delivered chunk stays in state.sent, so the publish after a resume
            // rebuilds only the undelivered tail rather than paying twice.
            if(this.spendGuard.isPaused()){
                for(let j = i; j < tokens.length; j++) this.spendGuard.release(tokens[j]);
                // Phase 'failed', not a new 'paused' phase: _loadSpendLog decides
                // after a restart from these phases, and only 'failed' un-commits an
                // epoch whose chunks never went out. A phase the loader does not know
                // leaves the bare 'intent' standing, which would quarantine the epoch
                // permanently for a hub the operator merely paused and resumed.
                this._recordSpend({ phase: 'failed', epoch: state.epoch, kind,
                                    delivered: state.sent.size, remaining: chunks.length - i,
                                    error: 'operator pause: ' + this.spendGuard.noteBlocked() });
                console.warn(this.spendGuard.noteBlocked() + ' (epoch ' + state.epoch +
                             ', ' + kind + '); ' + (chunks.length - i) + ' of ' + chunks.length +
                             ' chunk(s) not broadcast');
                this._committed.delete(key);
                return 'retry';
            }
            let chunk = chunks[i];
            let wire = this._buildWire(state.epoch, state.ledgerHash, myPubkey, chunk);
            try {
                let res = await this._broadcast(wire);
                // The reservation IS the spend; record() here would count it twice.
                this.spendGuard.commit(tokens[i]);
                let txid = (res && res.txid) ? String(res.txid) : null;
                if(txid) state.txids.push(txid);
                // Mark delivery per chunk, not per batch: a later chunk's failure
                // must not un-send the ones already on the wire.
                for(let p of chunk){
                    state.sent.add(p.pubkey);
                    if(p.pubkey === myPubkey) state.ownSigOnWire = true;
                }
                this._recordSpend({ phase: 'sent', epoch: state.epoch, kind, txid, pairs: chunk.length,
                                    rank: state.myRank });
                console.log('RollcallRound: published epoch=' + state.epoch + ' ' + kind + ' pairs=' + chunk.length +
                            (txid ? ' txid=' + txid : '') +
                            (state.myRank > 0 ? ' [SWEEPER: rank ' + state.myRank + ' of ' + state.order.length +
                                                '; the elected leader left these signatures off chain]' : ''));
            } catch(e){
                if(isAmbiguousSendError(e)){
                    // The send may have been accepted, so this chunk's reservation is
                    // a real spend and only the untried chunks give their budget back.
                    this.spendGuard.commit(tokens[i]);
                    for(let j = i + 1; j < tokens.length; j++) this.spendGuard.release(tokens[j]);
                    // Keep the epoch committed and say so on disk, so an operator
                    // reconciling on chain has the epoch without stdout retention.
                    this._recordSpend({ phase: 'ambiguous', epoch: state.epoch, kind,
                                        error: e && e.message ? String(e.message).slice(0, 200) : String(e) });
                    console.warn('RollcallRound: AMBIGUOUS publish send (epoch ' + state.epoch + ', ' + kind +
                                 '); NOT re-broadcasting to avoid a double spend:', e && e.message ? e.message : e);
                    return 'held';
                }
                // Definitive: nothing left this chunk, so it consumes no budget, and
                // neither do the chunks after it. Keeping them reserved would make a
                // failed send cost the window an allowance it never spent.
                for(let j = i; j < tokens.length; j++) this.spendGuard.release(tokens[j]);
                this._recordSpend({ phase: 'failed', epoch: state.epoch, kind, delivered: state.sent.size,
                                    error: e && e.message ? String(e.message).slice(0, 200) : String(e) });
                console.warn('RollcallRound: publish failed (epoch ' + state.epoch + ', ' + kind + '):',
                             e && e.message ? e.message : e);
                this._committed.delete(key);
                return 'retry';
            }
        }
        return result;
    }

    // Which of the signatures this hub holds are already on chain for the epoch.
    // Returns a Set of pubkeys, or null when the answer cannot be trusted.
    //
    // `max_block_time` is a WINDOW CUT the DOGE indexer applies to its own blocks.
    // The chain's cut is the BTC header stamp at E + ACCEPT_WINDOW, which does not
    // exist yet while we are still publishing, so this read uses a generous
    // wall-clock bound instead: any DOGE block it admits is one that landed before
    // the real cut, because we only publish while the tip is inside the window.
    // The answer is therefore a subset of what will count, never a superset, so it
    // can cost a duplicate fee and can never cost a missing signature.
    async _onChainSigners(state){
        let keys = Array.from(state.sigs.keys());
        if(keys.length === 0) return new Set();
        let res;
        try {
            res = await this._dogeIndexerCall('getrollcallsigners', {
                network:        this.network,
                epoch_height:   state.epoch,
                // Two hours of slack over wall clock: a DOGE miner may stamp a
                // block that far ahead, and excluding such a block would only
                // under-report what is already landed.
                max_block_time: Math.floor(Date.now() / 1000) + 7200,
                pubkeys:        keys,
                publishers:     []
            });
        } catch(e){
            return null;
        }
        if(!res || typeof res !== 'object' || !res.signers || typeof res.signers !== 'object') return null;
        // A null hcut means no DOGE block is inside the window yet, so the empty
        // maps are a shape and not a positive "none".
        if(res.hcut === null || res.hcut === undefined) return null;
        let out = new Set();
        for(let pk of Object.keys(res.signers)){
            let row = res.signers[pk];
            if(!row) continue;
            // A row carried under a different ledger_hash is one the BTC close
            // will discard, so it is not presence and must not suppress a real
            // publish of the same key.
            if(String(row.ledger_hash || '').toLowerCase() !== state.ledgerHash) continue;
            out.add(String(pk).toLowerCase());
        }
        state.onChainCount = out.size;
        return out;
    }

    // ── the DOGE rail ────────────────────────────────────────────────────────

    // Borrow the shared DOGE signer exactly as StateAnchorPublisher borrows the
    // price publisher's: HUB_SIGNER_MODULE's contract is unchanged and there is
    // one wiring point for all on-chain DOGE publishing.
    _resolveSigner(){
        let op = (this.hub && this.hub.oraclePublisher) || {};
        return {
            broadcastFn:  this.broadcastFn  || op.broadcastFn  || null,
            walletSignFn: this.walletSignFn || op.walletSignFn || null,
            getBalanceFn: this.getBalanceFn || op.getBalanceFn || null,
            encoder:      this.encoder      || op.encoder      || null
        };
    }

    // Can this hub actually land a roll call? Every ROLLCALL is a two-phase P2SH
    // publish and the built-in pipeline can only broadcast the funding tx, so a
    // signer module without `broadcast(payload)` can sign roll calls all day and
    // never publish one. Reported by getrollcallstatus so that gap is visible
    // rather than showing up as a federation that mysteriously never rolls.
    broadcastCapable(){
        return typeof this._resolveSigner().broadcastFn === 'function';
    }

    // Gate every publish path on it, and say so exactly once: this is a standing
    // deployment condition, not an event, and it is re-evaluated every tick.
    _requireBroadcast(){
        if(this.broadcastCapable()) return true;
        if(!this._loggedNoBroadcast){
            this._loggedNoBroadcast = true;
            console.warn('RollcallRound: this hub signs and gossips roll calls but cannot PUBLISH one: ' +
                         'HUB_SIGNER_MODULE exports no broadcast(payload), and every ROLLCALL is a two-phase ' +
                         'P2SH action the built-in encoder pipeline fails closed on. Its own presence still ' +
                         'reaches the chain through the sweepers. See examples/doge-signer.example.js.');
        }
        return false;
    }

    async _broadcast(payload){
        let signer = this._resolveSigner();
        if(typeof signer.broadcastFn === 'function') return await signer.broadcastFn(payload);
        // Reached only if the capability check above was bypassed. Build far
        // enough to hit the two-phase guard, which refuses BEFORE the wallet hook
        // runs, so nothing is signed and no fee is spent.
        if(!signer.encoder)      throw new Error('no encoder configured (set DOGE_ENCODER_URL)');
        if(!signer.walletSignFn) throw new Error('no wallet sign hook configured');
        if(!this.dogeAddress)    throw new Error('no DOGE_ADDRESS configured');
        let utxos = await signer.encoder.getUtxos(this.dogeAddress);
        if(!utxos || (Array.isArray(utxos) && utxos.length === 0))
            throw new Error('no UTXOs available for ' + this.dogeAddress);
        let built = await signer.encoder.createTx({
            utxos: forwardableUtxos(utxos, 'RollcallRound'), pubkey: this.dogeAddress,
            data: payload, change: this.dogeAddress, encoding: 'P2SH'
        });
        if(!built || !built.psbt) throw new Error('encoder returned no PSBT');
        assertSingleTxEncoding(built, 'RollcallRound');
        let txHex = await signer.walletSignFn(built.psbt);
        if(!txHex || typeof txHex !== 'string') throw new Error('wallet sign hook returned invalid tx hex');
        return await signer.encoder.broadcastTx(txHex);
    }

    // ── durable records ──────────────────────────────────────────────────────

    // Append one fsync'd line. Returns true only on a confirmed durable write;
    // the intent call gates on that result, the outcome calls are best-effort
    // because the fee is already committed by then.
    _appendLine(file, obj){
        let line = JSON.stringify(obj) + '\n';
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            let fd = fs.openSync(file, 'a');
            try { fs.writeSync(fd, line); fs.fsyncSync(fd); }
            finally { fs.closeSync(fd); }
            return true;
        } catch(e){
            console.error('RollcallRound: failed to write ' + file + ':', e && e.message ? e.message : e);
            return false;
        }
    }

    // Every durable record names the identity that wrote it, so a log that
    // holds another hub's lines (a copied config dir, a shared audit path) can
    // be told apart from this hub's own on the next boot.
    _ownPubkey(){
        return this.identity ? String(this.identity.getPubkeyHex()).toLowerCase() : null;
    }

    _recordSpend(entry){
        return this._appendLine(this.spendLogPath,
            Object.assign({ ts: Date.now(), effector: 'ROLLCALL_PUBLISH', pubkey: this._ownPubkey() || undefined }, entry));
    }

    // A signature costs nothing on chain, so an unwritable path must not stop the
    // hub answering an epoch; it only costs the restart re-emit.
    _recordSignature(entry){
        return this._appendLine(this.signLogPath, Object.assign({ ts: Date.now() }, entry));
    }

    // Fold the append-only spend log into the set of epochs whose fee is already
    // committed. Same sticky rules the other effectors use: a terminal 'sent' or
    // 'ambiguous' is committed and never cleared; a bare 'intent' counts as
    // committed (the transaction may have reached the node); only a 'failed', the
    // definitive pre-send failure, clears a bare intent so a genuine retry runs.
    //
    // LAST-RECORD-WINS below the sticky 'sent', not first: an epoch that failed
    // definitively and then retried appends a SECOND intent, and that intent must
    // re-arm the guard exactly like the first.
    _loadSpendLog(){
        let text;
        try { text = fs.readFileSync(this.spendLogPath, 'utf8'); }
        catch(e){ return; }
        let mine = this._ownPubkey();
        let outcome = new Map();
        for(let line of text.split('\n')){
            if(!line.trim()) continue;
            let rec;
            try { rec = JSON.parse(line); } catch(_){ continue; }   // a torn tail line
            let epoch = Number(rec.epoch);
            if(!Number.isFinite(epoch)) continue;
            // Another identity's spend is not this hub's commitment. A record
            // naming no pubkey predates the field and is kept as this hub's own.
            if(mine && rec.pubkey && String(rec.pubkey).toLowerCase() !== mine) continue;
            let key   = rec.kind === 'self' ? (epoch + ':self') : String(epoch);
            let prior = outcome.get(key);
            if(rec.phase === 'sent' || rec.phase === 'ambiguous') outcome.set(key, 'sent');
            else if(prior === 'sent') continue;
            else if(rec.phase === 'failed') outcome.set(key, 'failed');
            else if(rec.phase === 'intent') outcome.set(key, 'intent');
        }
        for(let [key, st] of outcome) if(st === 'sent' || st === 'intent') this._committed.add(key);
    }

    // Last write wins: a re-signature for the same epoch (a reorg changed the
    // ledger_hash under us) supersedes the earlier one.
    //
    // ONLY THIS HUB'S OWN LINES. A restored signature is re-emitted under this
    // hub's pubkey without re-signing, so a line another identity wrote would be
    // broadcast as ours: every peer drops it at verification, this hub records
    // nothing of its own for the epoch, and it reads as ABSENT while believing
    // it signed. Measured on the regtest acceptance venue on 2026-09-04, where
    // three in-process hubs shared one log and the restarted hub carried a
    // peer's signature on its own self-publish.
    _loadSignLog(){
        let text;
        try { text = fs.readFileSync(this.signLogPath, 'utf8'); }
        catch(e){ return; }
        let mine = this._ownPubkey();
        for(let line of text.split('\n')){
            if(!line.trim()) continue;
            let rec;
            try { rec = JSON.parse(line); } catch(_){ continue; }
            let epoch = Number(rec.epoch);
            let lh    = String(rec.ledger_hash || '').toLowerCase();
            let sig   = String(rec.sig || '').toLowerCase();
            if(!Number.isFinite(epoch)) continue;
            if(!/^[0-9a-f]{64}$/.test(lh) || !/^[0-9a-f]{128}$/.test(sig)) continue;
            if(mine && String(rec.pubkey || '').toLowerCase() !== mine) continue;
            this._signatures.set(epoch, { ledgerHash: lh, sig });
        }
    }

    // ── status ───────────────────────────────────────────────────────────────

    // PUBLISHER STATE ONLY. No ledger facts (last_rolled_epoch, absent_streak)
    // live here: those are the BTC indexer's and are authoritative there, and
    // serving a per-epoch view of who did and did not sign is a pre-eviction
    // targeting surface, which is why the RPC is in SENSITIVE_READ_METHODS.
    getStatus(){
        let epochs = Array.from(this.rounds.keys()).sort((a, b) => b - a);
        let state  = epochs.length > 0 ? this.rounds.get(epochs[0]) : null;
        if(!state){
            return { epoch: null, signed: false, gossiped_count: 0, on_chain_count: null,
                     leader: null, our_rank: -1, txids: [], broadcast_capable: this.broadcastCapable() };
        }
        return {
            epoch:             state.epoch,
            signed:            state.signed,
            gossiped_count:    state.sigs.size,
            on_chain_count:    state.onChainCount,
            leader:            state.leader,
            our_rank:          state.myRank,
            txids:             state.txids.slice(),
            broadcast_capable: this.broadcastCapable()
        };
    }
}

module.exports = RollcallRound;
module.exports.XROLLCALL_SIGN       = XROLLCALL_SIGN;
module.exports.MAX_PAIRS_PER_ACTION = MAX_PAIRS_PER_ACTION;
module.exports.PUBLISH_DELAY_DEFAULTS      = PUBLISH_DELAY_DEFAULTS;
module.exports.ELECTION_TOLERANCE_DEFAULTS = ELECTION_TOLERANCE_DEFAULTS;
module.exports.SELF_PUBLISH_DEFAULTS       = SELF_PUBLISH_DEFAULTS;
