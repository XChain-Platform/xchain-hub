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
 * The propagation window a policy snapshot's effective_time carries.
 *
 * the token bridge policy spec section 5, echoed by the
 * effective_time column comment in src/sql/policy_snapshots.sql:
 *
 *     now + max(relayMarginFloorS(c)) over every chain c that holds a COPY
 *     of this tick per the hub's own bridge_transfers rows
 *
 * The first cut seeded the maximum with relayMarginFloorS('BTC'), so EVERY
 * snapshot came out at 2400 s whether or not a copy lived on BTC. That is not
 * a safety margin, it is forty minutes of delay on every policy change to a
 * token that never touched Bitcoin. The expectations below are spelled out in
 * seconds rather than re-derived from relayMarginFloorS, so a change to the
 * nominal block intervals shows up here as a decision rather than as silence.
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');

const CrossChainBridgeEngine = require('../../src/CrossChainBridgeEngine.js');
const { relayMarginFloorS, RELAY_MIN_FUTURE_S } = require('../../src/lib/relay_margin.js');

// The engine with nothing wired: _policyMarginS is pure, and the constructor is the only
// thing it needs. p2pConfig carries the indexer URLs so the constructor takes the same
// branch a live hub does.
function bareEngine(){
    const hub = {
        db:   { doQuery: async () => [] },
        network: 'regtest',
        p2pConfig: { BTC_INDEXER_URL: 'http://btc', DOGE_INDEXER_URL: 'http://doge', LTC_INDEXER_URL: 'http://ltc' },
        getPeerManager: () => null,
        getIdentity:    () => null
    };
    const engine = new CrossChainBridgeEngine(hub);
    const stub = () => ({ propose: sinon.stub().resolves(), start: sinon.stub(), stop: sinon.stub(),
                          on: () => {}, forgetFinalized: sinon.stub() });
    engine.transferConsensus = stub();
    engine.policyConsensus   = stub();
    return engine;
}

describe('CrossChainBridgeEngine: the policy snapshot propagation margin', function(){

    afterEach(function(){ sinon.restore(); });

    // 4 nominal blocks of the gating chain, capped at 3000 s: DOGE 60 s -> 240,
    // LTC 150 s -> 600, BTC 600 s -> 2400.
    it('the three floors this rule is made of are the ones the spec quotes', function(){
        expect(relayMarginFloorS('DOGE')).to.equal(240);
        expect(relayMarginFloorS('LTC')).to.equal(600);
        expect(relayMarginFloorS('BTC')).to.equal(2400);
    });

    it('copies {DOGE} gives 240 s, not BTC\'s 2400', function(){
        expect(bareEngine()._policyMarginS(new Set(['DOGE']), 'BTC')).to.equal(240);
    });

    it('copies {DOGE, LTC} gives the larger of the two', function(){
        expect(bareEngine()._policyMarginS(new Set(['DOGE', 'LTC']), 'BTC')).to.equal(600);
    });

    it('a BTC copy pins it at 2400 s however fast the other copies are', function(){
        expect(bareEngine()._policyMarginS(new Set(['DOGE', 'BTC']), 'DOGE')).to.equal(2400);
        expect(bareEngine()._policyMarginS(new Set(['BTC']), 'DOGE')).to.equal(2400);
    });

    // No copy means no destination to reach, but the row still has to sit far enough in the
    // future that an honest follower will co-sign it.
    it('with no copies it falls back to the origin chain, and stays above the follower floor', function(){
        const engine = bareEngine();
        expect(engine._policyMarginS(new Set(), 'DOGE')).to.equal(240);
        expect(engine._policyMarginS(new Set(), 'LTC')).to.equal(600);
        expect(engine._policyMarginS(new Set(), 'DOGE')).to.be.above(RELAY_MIN_FUTURE_S);
    });

    // The margin reaches the signed row through _maybeSnapshotPolicy, which is where a
    // regression would actually bite. Drive that path for a DOGE-only token and read the
    // effective_time off the row handed to the consensus.
    it('stamps the copy-sized margin on the row it proposes, not a BTC-sized one', async function(){
        const engine = bareEngine();
        engine.activation = { bridge: () => true, token: () => true, policy: () => true };
        engine.db.getLatestPolicySeq      = async () => 0;
        engine.db.getPolicySnapshotAtSeq  = async () => null;
        engine._indexerCall = async (coin, method) => {
            if(method === 'getlatestblock')  return { block_index: 500 };
            if(method === 'gettokenpolicy')  return {
                allow_list: null, block_list: null, sleeping: false,
                policy_hash: engine._policyHash(null, null, false)
            };
            return null;
        };
        const before = engine._nowSeconds();
        await engine._maybeSnapshotPolicy(
            { origin_chain: 'BTC', tick: 'FUFU', copies: new Set(['DOGE']) }, 'regtest', 150);

        expect(engine.policyConsensus.propose.calledOnce).to.equal(true);
        const row = engine.policyConsensus.propose.firstCall.args[1].row;
        // now + 240, allowing the second the call itself may have crossed.
        expect(row.effective_time - before).to.be.within(240, 241);
    });
});
