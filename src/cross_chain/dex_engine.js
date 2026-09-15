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

const EventEmitter = require('events');
const axios        = require('axios');

const bc                     = require('../bcmath.js');
const eq                     = require('../equivocation_header.js');
const ccr                    = require('../cross_chain_royalty_activation.js');
const ah                     = require('../lib/admission_height.js');
const CrossChainDexConsensus = require('./dex_consensus.js');
const snapWrite              = require('../lib/capability_snapshot_write.js');
const hubConfig = require('../config');
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();
const { installParts } = require('./prototype_parts.js');
const { ALLOWED_CHAINS, DEFAULT_POLL_MS } = require('./dex/constants.js');
const ledgerPart   = require('./dex/ledger.js');
const matchPart    = require('./dex/match.js');
const finalizePart = require('./dex/finalize.js');
const validatePart = require('./dex/validate.js');
const plumbingPart = require('./dex/plumbing.js');

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
        this.pollMs = parseInt(hubConfig.XDEX_POLL_MS || cfg.XDEX_POLL_MS || DEFAULT_POLL_MS);

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
        this._snapshotBlockOverride = _isRegtest ? parseInt(hubConfig.XDEX_SNAPSHOT_BLOCK || cfg.XDEX_SNAPSHOT_BLOCK) : NaN;
        this._seedLocalValidator    = _isRegtest && (hubConfig.XDEX_SEED_LOCAL_VALIDATOR === '1' ||
                                       cfg.XDEX_SEED_LOCAL_VALIDATOR === '1' || cfg.XDEX_SEED_LOCAL_VALIDATOR === true);

        // Per-coin indexer JSON-RPC endpoints for the matching view (federation read
        // methods need the api key): <COIN>_INDEXER_URL, <COIN>_INDEXER_API_KEY.
        this.indexers = {};
        for(let coin of ALLOWED_CHAINS){
            this.indexers[coin] = {
                url: hubConfig.env()[coin + '_INDEXER_URL'] || cfg[coin + '_INDEXER_URL'] || '',
                key: hubConfig.env()[coin + '_INDEXER_API_KEY'] || cfg[coin + '_INDEXER_API_KEY'] || ''
            };
        }

        this.initMatchState(cfg);

        // PBFT consensus over each match. Single-node (quorum 0) collapses to an
        // immediate self-sign + finalize, so behavior with no federation is unchanged.
        this.consensus = new CrossChainDexConsensus(this);
        this.consensus.on('match:finalized', (ev) => {
            this.writeFinalizedMatch(ev).catch(err =>
                logger.error(nodeUtil.format('CrossChainDex: write finalized match error:', err && err.message)));
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
                logger.warn('CrossChainDex: no indexer URL for chain ' + coin + ' (set ' + coin + '_INDEXER_API_URL / ' + coin + '_INDEXER_URL, or push it via xchain-node updateconfig); this chain is skipped every tick until configured');
        }
        await this.rebuildCommitted();
        await this.consensus.start();           // subscribes to P2P; drives PBFT match rounds
        this._pollTimer = setInterval(() => {
            this._discoverAndMatch().catch(err => logger.error(nodeUtil.format('CrossChainDex: tick error:', err && err.message)));
        }, this.pollMs);
        logger.info('Cross-chain DEX engine started (poll ' + this.pollMs + 'ms)');
    }

    async stop(){
        if(this._pollTimer){ clearInterval(this._pollTimer); this._pollTimer = null; }
        await this.consensus.stop();
    }

    // ORDER↔ORDER book match with partial fills. Mirrors the indexer's local matcher
    // (xchain-indexer/src/actions/order_match.js): structural cross-compat, price-cross
    // gate, then the bottleneck clamp with orderInfo = taker (later) / matchInfo = maker
    // (earlier). Fill quantities are computed on effective_remaining (committed-aware), so
    // the same mirrored state always re-derives the same fill (PBFT determinism).
    tryOrderMatch(a, b){
        let priced = this.orderPricing(a, b);
        if(!priced) return null;
        let { maker, taker, ownership, takerGivePrice, takerGetPrice, takerRem, makerRem } = priced;

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
        let fill = this.quantizeFill(maker, taker, takerGive, takerGet);
        if(!fill) return null;
        takerGive = fill.takerGive;
        takerGet  = fill.takerGet;

        if(ownership){
            // Ownership orders are single-fill exact (order_match.js:166-180): the fill must
            // equal the full canonical sides, no partials.
            let expGive = Number(taker.give_ownership || 0) === 1 ? '1' : String(taker.give_amount);
            let expGet  = Number(taker.get_ownership  || 0) === 1 ? '1' : String(taker.get_amount);
            if(!this.amountsEqual(takerGive, expGive) || !this.amountsEqual(takerGet, expGet)) return null;
        }

        // taker gives takerGive (its escrow); maker gives takerGet (== what the taker receives).
        let aGiveFill = (a === taker) ? takerGive : takerGet;
        let bGiveFill = (b === taker) ? takerGive : takerGet;
        return this.buildDesc(a, b, 'order', 'order', aGiveFill, bGiveFill);
    }

    async stampMatchAdmission(row, matchId){
        // The ADMISSION MAP, stamped over the chains that READ this match (a_chain OR
        // b_chain, from the consuming selects) at this hub's own fresh admission tip on
        // each, plus the table's block margin. Height-gated on the row's own
        // snapshot_block, so the era for this match is fixed here and every canonical
        // built for it afterwards reads the stored columns.
        //
        // C4: with no fresh tip for either chain this hub REFUSES to finalize the match
        // rather than guessing a height. A guessed height forks (two hubs stamp different
        // maps for the same match and neither quorum reproduces), a refusal stalls this
        // one pairing and says which chain's decoder went away.
        let admitMap = null;
        if(ah.isAdmissionEra(row.network, row.snapshot_block)){
            let readSet = ah.admissionReadSet('cross_chain_matches', row);
            admitMap = this.hub && typeof this.hub.resolveAdmitBlocks === 'function'
                ? await this.hub.resolveAdmitBlocks('cross_chain_matches', readSet) : null;
            if(!admitMap){
                logger.error('CrossChainDex: refusing to finalize match ' + matchId.substring(0,16) +
                    '... at snapshot_block ' + row.snapshot_block + '; no fresh admission tip for ' +
                    readSet.join(' / '));
                return false;
            }
        }
        // Every column named at every height, so a legacy row carries explicit NULLs rather
        // than an absent key the driver would have to coerce. NULL is the legacy row and it
        // binds by effective_time, which is what a below-the-activation match must do.
        Object.assign(row, ah.admitBlocksToColumns(admitMap));
        return true;
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
        // The admission map, height-gated on the ROW's own snapshot_block and never on a
        // consumer's height, so the rule for a match is fixed the moment it is produced and
        // the two eras can never share a signature. Refuses in BOTH directions, exactly as
        // AttestationConsensus.buildCanonical does for the mirror era. Appended LAST so its
        // '|' separator argument holds whatever the royalty gate did before it.
        raw += ah.admissionCanonicalField('CrossChainDex', r.network, r.snapshot_block, ah.rowAdmitBlocks(r));
        if(eq.isEquivHeaderActive(r.snapshot_block, r.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, r.match_id, (view != null ? view : 0), raw);
        return raw;
    }

    // Persist the qualifying validator set for `capability` at `block` to
    // capability_snapshots (idempotent), and mirror each row to indexers. Writes the
    // source-keyed weight (amount column) + the source discriminator so non-BTC
    // indexers + recovery can dedupe quorum weight by staking address.
    // Returns the number of capability rows resolved (and persisted) for this
    // (capability, block). A return of 0 means the snapshot degraded to an empty
    // set (indexer RPC error / auth mismatch surfaces as a null snapshot, which
    // resolveCapabilityValidators normalizes to []), so callers on the money path
    // can fail closed rather than committing a match whose signatures no mirror can
    // verify against capability_snapshots.
    async _persistCapabilitySnapshot(capability, block, network){
        let validators = await this.resolveCapabilityValidators(capability, block, network);
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
            logger.warn('CrossChainDex: refusing to persist a TRUNCATED ' + capability +
                         ' capability snapshot at block ' + block +
                         ' (over the source cap; raise VALIDATOR_QUERY_LIMIT fleet-wide). No rows mirrored.');
            return 0;
        }
        // One statement for the whole set: a per-row loop left the mirror PARTIAL on any
        // single INSERT throw, and a partial set has no completeness marker so a verifier
        // reads it as COMPLETE. Rationale in lib/capability_snapshot_write.js. Parity with
        // StateCheckpointEngine and the other four writers.
        //
        // The chain identity is passed rather than left to the writer's own lookup: this
        // engine knows the row's network, so the snapshot a match is verified against carries
        // the same identity the match row does, even on a hub whose HUB_NETWORK is unset.
        let rows = await snapWrite.writeCapabilitySnapshotRows(
            this.db, capability, block, validators, await this.resolveBtcChainId(network));
        for(let row of rows){
            if(this.broadcaster){
                // Select back on the full widened uq_cap_snap
                // (snapshot_block, capability, signing_pubkey, source). A pubkey-only
                // select-back re-read the SAME row for every source of a delegated key
                // (LIMIT 1), so the mirror stream carried one source and the off-BTC
                // match verifier tallied an under-counted denominator. Inert below SWQ,
                // where source='' and there is one row per key.
                let r = await this.db.getCapabilitySnapshot(block, capability, row.signing_pubkey, row.source);
                if(r.length) this.broadcaster.broadcastRow({ table: 'capability_snapshots', row: r[0] });
            }
        }
        return validators.length;
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

installParts(CrossChainDexEngine.prototype, [
    ledgerPart, matchPart, finalizePart, validatePart, plumbingPart
]);

module.exports = CrossChainDexEngine;
