'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The two-hub rig for the ARCHIVE election key and the stale-batch-seq
// convergence path. In-process, no chain, no DB: two StateAnchorPublisher instances over
// a gossip bus whose XANC_FINALIZED delivery can be WITHHELD from one hub, which is
// exactly how the two hubs' cross_chain_matches tables come to disagree in production
// (a dropped announcement, a hub restarting through the round, a partitioned peer).
//
// THE HAZARD. An election key that binds _getNextBatchSeq(), i.e. MAX(batch_seq)+1
// over THIS hub's own cross_chain_matches / cross_chain_calls / validator_rewards, with
// no consensus step, is uniform only while every back-fill has landed; once one hub misses
// one, the two compute DIFFERENT keys for
// the SAME wrapper checkpoint, and the failover ladder stops being a shared ordering:
//   - observed live as two archives at batches 26 and 27 for one wrapper in one window,
//     each hub rank 0 under its own key, both indexing valid;
//   - and then as a stuck federation after a degraded round, hub0 reading batch 38 self
//     rank 1, hub1 reading batch 39 self rank 1, NEITHER publishing.
//
// WHAT THIS RIG PINS.
//   1. Both hubs derive the SAME rank order for the wrapper while their batch seqs differ.
//   2. Only the unlocked rank publishes.
//   3. The lagging hub does NOT put a second archive on the wire for that wrapper under a
//      different batch_seq: the co-signer that already holds the seq as consumed refuses,
//      naming both seqs, and the round is abandoned rather than re-proposed forever.
//   4. After the lagging hub learns the consumed seq (by refusal, or by the withheld
//      XANC_FINALIZED finally arriving) its next seq equals the leader's.

const { expect }            = require('chai');
const os                    = require('os');
const path                  = require('path');
const StateAnchorPublisher  = require('../../../src/StateAnchorPublisher');
const ValidatorIdentity     = require('../../../src/ValidatorIdentity');
const eq                    = require('../../../src/equivocation_header.js');
const ccr                   = require('../../../src/cross_chain_royalty_activation.js');
const arMod                 = require('../../../src/anchor_reward_activation.js');
const { waitUntil }         = require('../../helpers/waitUntil');

// 'mainnet' at snapshot_block 100 is the fully-legacy path (SWQ, EQUIV, the reward
// flag-days and the royalty leg all activate at/above 961000 there), so the round runs
// the plain 2f+1 COUNT quorum: for a 2-member set, bftQuorum(2) === 2, which is what
// makes the follower's co-signature load-bearing and its REFUSAL decisive.
const NETWORK = 'mainnet';
const BLOCK   = 100;                                // wrapper snapshot_block
const TOL     = 36;                                 // ANCHOR_ELECTION_TOLERANCE_BLOCKS default

const CP_ROW = {
    id: 1, chain: 'BTC', network: NETWORK, block_index: 494, block_hash: 'c0'.repeat(32),
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    checkpoint_seq: 7, snapshot_block: BLOCK, validator_signatures: '[]',
    anchor_txid: 'already-anchored',                // v0 leg is out of scope; keep flush on the archive
    state_root: 'd4'.repeat(32), state_root_version: 1,
    block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1
};

function matchRow(id){
    return {
        id: 1, match_id: id, snapshot_block: BLOCK, network: NETWORK,
        a_chain: 'LTC', a_action_index: 5, a_kind: 'swap', a_tick: 'TOKA', a_amount: '1000',
        a_filled_before: '0', a_ownership: 0, a_payout_addr: 'Lpay',
        b_chain: 'DOGE', b_action_index: 8, b_kind: 'swap', b_tick: null, b_amount: '2000',
        b_filled_before: '0', b_ownership: 0, b_payout_addr: 'Dpay',
        effective_time: 1700000000, validator_signatures: null,
        status: 'finalized', batch_root: null, anchor_txid: null, batch_seq: null, archived_status: null
    };
}

// Mirror of the publisher's _matchCanonical, so fixture rows carry REAL signatures and
// the follower's cryptographic verification is the shipped one.
function matchCanonical(m){
    let raw = ['XMATCH', m.match_id, String(m.snapshot_block),
        m.a_chain, String(m.a_action_index), m.a_tick || '', String(m.a_amount), String(m.a_ownership), m.a_payout_addr,
        m.b_chain, String(m.b_action_index), m.b_tick || '', String(m.b_amount), String(m.b_ownership), m.b_payout_addr,
        String(m.effective_time), m.network || '',
        m.a_kind || 'swap', String(m.a_filled_before != null ? m.a_filled_before : '0'),
        m.b_kind || 'swap', String(m.b_filled_before != null ? m.b_filled_before : '0')].join('|');
    if(ccr.isCrossChainRoyaltyActive(m.snapshot_block, m.network))
        raw += '|' + String(m.a_payout_legs || '') + '|' + String(m.b_payout_legs || '');
    if(eq.isEquivHeaderActive(m.snapshot_block, m.network))
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, m.match_id, 0, raw);
    return raw;
}

// The publisher's query surface, in memory. Only the archive leg is exercised, so this
// is the match + checkpoint + batch-seq subset of the unit mesh's memDb.
function memDb(){
    let matches = [], checkpoints = [];
    return {
        matches, checkpoints,
        async doQuery(sql, params){
            params = params || [];
            if(sql.startsWith("SELECT * FROM state_checkpoints WHERE network = ? ORDER BY (chain = 'BTC') DESC"))
                return checkpoints.filter(r => r.network === params[0]).slice(0, 1);
            if(sql.startsWith("SELECT * FROM state_checkpoints ORDER BY (chain = 'BTC') DESC"))
                return checkpoints.slice(0, 1);
            if(sql.startsWith('SELECT * FROM state_checkpoints WHERE chain = ?')){
                let hits = checkpoints.filter(r => r.chain === params[0] && r.network === params[1] &&
                                                   r.block_index === params[2]);
                if(sql.indexOf('AND checkpoint_seq = ?') !== -1) hits = hits.filter(r => r.checkpoint_seq === params[3]);
                return hits.slice(0, 1);
            }
            if(sql.startsWith('SELECT sc.* FROM state_checkpoints sc JOIN')) return [];   // v0 leg: nothing pending
            if(sql.startsWith('SELECT * FROM cross_chain_matches WHERE batch_seq IS NULL OR archived_status <> status'))
                return matches.filter(r => r.batch_seq == null || r.archived_status !== r.status).slice(0, params[0]);
            if(sql.startsWith('SELECT * FROM cross_chain_matches WHERE match_id = ?'))
                return matches.filter(r => r.match_id === params[0]).slice(0, 1);
            if(sql.startsWith('SELECT * FROM cross_chain_matches WHERE match_id IN'))
                return matches.filter(r => params.includes(r.match_id) && r.status !== 'retracted');
            if(sql.startsWith('SELECT COALESCE(GREATEST(')){
                let max = -1;
                for(let r of matches) if(r.batch_seq != null && r.batch_seq > max) max = r.batch_seq;
                return [{ next_seq: max + 1 }];
            }
            if(sql.startsWith('UPDATE cross_chain_matches SET batch_seq')){
                let onlyEligible = sql.includes('batch_seq IS NULL OR archived_status <> status');
                for(let r of matches)
                    if(r.match_id === params[3] &&
                       (!onlyEligible || r.batch_seq == null || r.archived_status !== r.status)){
                        r.batch_seq = params[0]; r.archived_status = params[1];
                        if(params[2] != null) r.anchor_txid = params[2];
                    }
                return [];
            }
            return [];
        }
    };
}

// Two publishers over one gossip bus. bus.withhold is a set of message TYPES that never
// reach a node in bus.deaf: that is the whole fault injection, and it models exactly the
// production failure (an XANC_FINALIZED that never lands) rather than hand-editing rows.
function buildRig(opts){
    opts = opts || {};
    let bus = { nodes: [], withhold: new Set(), deaf: new Set() };
    let identities = [0, 1].map(i => new ValidatorIdentity(String(10 + i).repeat(32).slice(0, 64)));
    let validators = identities.map(id => ({ pubkey: id.getPubkeyHex().toLowerCase(), amount: '1' }));

    for(let i = 0; i < 2; i++){
        let identity = identities[i];
        let self = { i, identity, pubkey: identity.getPubkeyHex().toLowerCase(),
                     handler: null, published: [], rewards: [], sent: [] };
        let peerManager = {
            on(evt, h){ if(evt === 'message') self.handler = h; },
            removeListener(evt){ if(evt === 'message') self.handler = null; },
            broadcast(type, data){
                self.sent.push({ type, data });
                let env = { type, sender: self.pubkey, data };
                for(let other of bus.nodes){
                    if(other === self) continue;
                    if(bus.deaf.has(other.i) && bus.withhold.has(type)) continue;   // the dropped announcement
                    if(other.handler) other.handler(env);
                }
            }
        };
        let db = memDb();
        db.checkpoints.push(Object.assign({}, CP_ROW));
        for(let m of (opts.matches || [matchRow('m1')])){
            let row = Object.assign({}, m);
            let canon = matchCanonical(row);
            row.validator_signatures = JSON.stringify(identities.map(id =>
                ({ pubkey: id.getPubkeyHex().toLowerCase(), sig: id.sign(canon) })));
            db.matches.push(row);
        }
        let hub = {
            db,
            p2pConfig: { ANCHOR_INTERVAL_MS: '3600000' },
            capabilitySnapshot: { async getSnapshot(){ return { validators: validators }; } },
            capabilityRegistry: { getActiveValidators: async () => validators.map(v => v.pubkey) },
            getPeerManager: () => peerManager,
            getIdentity: () => identity,
            rewardTracker: {
                anchorReward: '10.00000000',
                recordAnchorReward: async (type, round, pubkey, blk) => { self.rewards.push({ type, round, pubkey, blk }); },
                resolveSourceByPubkey: async (pubkey) => 'src_' + String(pubkey).toLowerCase().substring(0, 12)
            },
            _resolveBtcLatestBlock: async () => (opts.btcBlock != null ? opts.btcBlock : BLOCK)
        };
        self.db  = db;
        self.pub = new StateAnchorPublisher(hub);
        self.pub.spendGuard.statePath = path.join(
            os.tmpdir(), 'xc2291-spend-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.json');
        self.pub.setBroadcastHook(async (payload) => {
            self.published.push(payload);
            return { txid: 'txid' + self.i + '-' + self.published.length };
        });
        bus.nodes.push(self);
    }
    return bus;
}

// The rank order every hub is supposed to agree on, computed the way THAT hub computes
// it: its own wrapper row and its own drawn batch seq, never a shared constant. Passing
// the seq is deliberate even though the fixed key ignores it - it is precisely the input
// the two hubs disagree about, so this helper reproduces the leader's own derivation on
// either build and the divergence lands on the assertion rather than on the fixture.
async function keyAt(nd){
    let rows = await nd.db.doQuery(
        "SELECT * FROM state_checkpoints WHERE network = ? ORDER BY (chain = 'BTC') DESC, checkpoint_seq DESC, snapshot_block DESC, block_index DESC LIMIT 1",
        [NETWORK]);
    return nd.pub._archiveElectionKey(nd.pub._cpFromRow(rows[0]), await nd.pub._getNextBatchSeq());
}
async function orderAt(nd, bus){
    return StateAnchorPublisher.hashOrder(await keyAt(nd), bus.nodes.map(n => n.pubkey));
}

const v1s = (nd) => nd.published.filter(p => String(p).split('|')[1] === '1');
const seqOf = (payload) => Number(String(payload).split('|')[11]);   // ANCHOR|1|chain|net|bi|bh|lh|ah|ch|seq|snap|BATCH_SEQ

describe('StateAnchorPublisher: archive election survives a batch-seq divergence', function () {

    let rigs = [];
    let savedAnchorFlagDay, savedArchiveFlagDay;
    beforeEach(function () {
        // Keep the mainnet reward flag-days where they are; the fixture block (100) is
        // already below them, but pin them so a future constant move cannot silently
        // route this rig onto the attestation path it is not testing.
        savedAnchorFlagDay  = arMod.ANCHOR_REWARD_ACTIVATION.mainnet;
        savedArchiveFlagDay = arMod.ARCHIVE_REWARD_ACTIVATION.mainnet;
        arMod.ANCHOR_REWARD_ACTIVATION.mainnet  = 999999999;
        arMod.ARCHIVE_REWARD_ACTIVATION.mainnet = 999999999;
    });
    afterEach(async function () {
        arMod.ANCHOR_REWARD_ACTIVATION.mainnet  = savedAnchorFlagDay;
        arMod.ARCHIVE_REWARD_ACTIVATION.mainnet = savedArchiveFlagDay;
        for(let bus of rigs) for(let nd of bus.nodes) await nd.pub.stop();
        rigs = [];
    });

    // Round one, with the FINALIZED withheld from one hub. Returns { bus, leader, lagging }
    // where `lagging` never learned that batch 0 was consumed: its own tables still say
    // next seq 0 while the leader's say 1. This is the production state the defect needs.
    async function divergeOnRoundOne(btcBlock){
        let bus = buildRig({ btcBlock: btcBlock });
        rigs.push(bus);
        for(let nd of bus.nodes) await nd.pub.start();

        let order  = await orderAt(bus.nodes[0], bus);
        let leader = bus.nodes.find(n => n.pubkey === order[0]);
        let laggy  = bus.nodes.find(n => n.pubkey === order[1]);

        bus.deaf.add(laggy.i);
        bus.withhold.add('XANC_FINALIZED');
        await leader.pub.flush();
        await waitUntil(() => v1s(leader).length === 1 && leader.db.matches[0].batch_seq === 0,
                        { label: 'round one to publish and back-fill the leader' });
        bus.withhold.clear();
        bus.deaf.clear();

        expect(laggy.db.matches[0].batch_seq, 'the lagging hub missed the back-fill').to.equal(null);
        expect(await leader.pub._getNextBatchSeq(), 'leader has consumed batch 0').to.equal(1);
        expect(await laggy.pub._getNextBatchSeq(), 'lagging hub still thinks 0 is free').to.equal(0);

        // Fresh cargo for round two, pending on BOTH hubs.
        for(let nd of bus.nodes){
            let row = Object.assign({}, matchRow('m2'));
            row.validator_signatures = JSON.stringify(bus.nodes.map(n =>
                ({ pubkey: n.pubkey, sig: n.identity.sign(matchCanonical(row)) })));
            nd.db.matches.push(row);
        }
        return { bus, leader, laggy };
    }

    it('both hubs derive the SAME rank order for the wrapper though their batch seqs differ', async function () {
        const { bus, leader, laggy } = await divergeOnRoundOne(BLOCK);

        // The precondition that made the old key diverge is real and still present.
        expect(await leader.pub._getNextBatchSeq()).to.equal(1);
        expect(laggy.pub._observedConsumedBatchSeq, 'nothing has taught the lagging hub yet').to.equal(-1);

        // The key first, because it is the property and it discriminates on a set of any
        // size: a rank ORDER over two members agrees half the time by chance even when the
        // two hubs ranked against different keys, so order equality alone would be a weak
        // pin on a 2-hub rig.
        expect(await keyAt(laggy), 'both hubs rank against the identical key').to.equal(await keyAt(leader));

        let a = await orderAt(leader, bus);
        let b = await orderAt(laggy, bus);
        expect(b, 'one wrapper, one rank order, regardless of back-fill lag').to.deep.equal(a);
        expect(a[0]).to.equal(leader.pubkey);
        expect(a[1]).to.equal(laggy.pubkey);
    });

    it('only the unlocked rank publishes: the locked backup defers instead of self-electing', async function () {
        const { leader, laggy } = await divergeOnRoundOne(BLOCK);   // since = 0 -> rank 1 locked

        let before = v1s(laggy).length;
        let out = await laggy.pub.flush();
        expect(out.archive, 'rank 1 is not unlocked at the anchor point').to.equal('none');
        expect(v1s(laggy).length, 'the locked backup put nothing on the wire').to.equal(before);

        await leader.pub.flush();
        await waitUntil(() => v1s(leader).length === 2, { label: 'the unlocked rank-0 leader to publish round two' });
        expect(seqOf(v1s(leader)[1]), 'leader draws its own next seq').to.equal(1);
    });

    it('the lagging hub does NOT publish a second archive for the wrapper under a stale seq', async function () {
        // Ladder unlocked for rank 1 (since = TOL), so the lagging hub really does open a
        // round: this is the case the old key turned into a duplicate archive.
        const { leader, laggy } = await divergeOnRoundOne(BLOCK + TOL);

        let out = await laggy.pub.flush();
        expect(out.archive, 'the unlocked backup opens a round').to.equal('round_started');
        await waitUntil(() => laggy.pub._observedConsumedBatchSeq >= 0,
                        { label: 'the co-signer refusal to reach the proposer' });

        // The co-signer refused rather than signing, so the round never reached quorum.
        expect(v1s(laggy).length, 'no second archive on the wire for this wrapper').to.equal(0);
        expect(laggy.pub._archiveRound, 'the round was abandoned, not left to re-propose').to.equal(null);
        // And the refusal named BOTH seqs: the proposal's, and the refuser's own consumed one.
        let refusal = leader.sent.find(m => m.type === 'XANC_SIGN' && m.data.consumed_seq !== undefined);
        expect(refusal, 'the refusal rode the existing XANC_SIGN, no new message type').to.not.equal(undefined);
        expect(refusal.data.batch_seq, 'names the proposal seq').to.equal(0);
        expect(refusal.data.consumed_seq, 'names the seq the refuser already holds').to.equal(0);
        expect(refusal.data.sig, 'no co-signature rides a refusal').to.equal('');

        // Convergence: the lagging hub's next seq is now the leader's.
        expect(await laggy.pub._getNextBatchSeq()).to.equal(await leader.pub._getNextBatchSeq());
    });

    it('a signed refusal is required: an unsigned or non-member one cannot abandon a round', async function () {
        const { bus, leader, laggy } = await divergeOnRoundOne(BLOCK + TOL);

        // Open a round with the honest co-signer out of earshot, so the only thing that
        // can close it is a refusal this test constructs.
        bus.deaf.add(leader.i);
        bus.withhold.add('XANC_SIGN_REQ');
        await laggy.pub.flush();
        let round = laggy.pub._archiveRound;
        expect(round, 'a round is open to attack').to.not.equal(null);

        let outsider = new ValidatorIdentity('99'.repeat(32));
        await laggy.pub._handleSign({ data: { batch_seq: round.batchSeq, sig_pubkey: leader.pubkey,
                                              sig: '', consumed_seq: 99 } });                        // unsigned
        expect(laggy.pub._archiveRound, 'an unsigned refusal is ignored').to.equal(round);
        await laggy.pub._handleSign({ data: { batch_seq: round.batchSeq, sig_pubkey: outsider.getPubkeyHex().toLowerCase(),
                                              sig: '', consumed_seq: 99,
                                              refusal_sig: outsider.sign(laggy.pub._seqRefusalCanonical(round.batchSeq, 99)) } });
        expect(laggy.pub._archiveRound, 'a non-member refusal is ignored').to.equal(round);
        expect(laggy.pub._observedConsumedBatchSeq, 'and neither moved the seq floor').to.equal(-1);

        // Positive control: the SAME shape, signed by the member that really holds the
        // seq, does close the round. Without this, the two refusals above could be
        // ignored for any reason at all.
        await laggy.pub._handleSign({ data: { batch_seq: round.batchSeq, sig_pubkey: leader.pubkey,
                                              sig: '', consumed_seq: round.batchSeq,
                                              refusal_sig: leader.identity.sign(
                                                  laggy.pub._seqRefusalCanonical(round.batchSeq, round.batchSeq)) } });
        expect(laggy.pub._archiveRound, 'the honest refusal abandons the round').to.equal(null);
        expect(laggy.pub._observedConsumedBatchSeq).to.equal(round.batchSeq);
    });

    it('the withheld XANC_FINALIZED converges the lagging hub when it finally arrives', async function () {
        // The other learning channel, with no refusal involved: the announcement the hub
        // missed is simply replayed to it, as a reconnecting peer would replay it.
        const { leader, laggy } = await divergeOnRoundOne(BLOCK);

        let fin = leader.sent.find(m => m.type === 'XANC_FINALIZED');
        expect(fin, 'round one announced a FINALIZED').to.not.equal(undefined);
        await laggy.pub._handleFinalized({ type: 'XANC_FINALIZED', sender: leader.pubkey, data: fin.data });

        expect(laggy.pub._observedConsumedBatchSeq, 'batch 0 learned as consumed').to.equal(0);
        expect(laggy.db.matches[0].batch_seq, 'and the missed back-fill actually landed').to.equal(0);
        expect(await laggy.pub._getNextBatchSeq()).to.equal(await leader.pub._getNextBatchSeq());
    });
});
