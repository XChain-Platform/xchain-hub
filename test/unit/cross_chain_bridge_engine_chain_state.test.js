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
 * Three things the first cut of the engine left unproven:
 *
 *   1. the chain half of getbridgeinvariant. escrow, supply and delta came
 *      back null on every hub because nothing was ever wired to read chain
 *      state, which made the watch item permanently UNKNOWN. The wiring is
 *      each chain's own indexer over getbridgebalances(tick), through the same
 *      per-chain client the pending-leg poll uses, and it has to read the two
 *      halves off the two DIFFERENT chains the invariant is stated over (base
 *      spec section 3): a copy chain's supply on the copy, the escrow backing
 *      it at ADDRESS.BRIDGE_<copy> on the ORIGIN.
 *   2. the TRUNCATED capability-snapshot refusal in _persistCapabilitySnapshot.
 *      The refusal was written but nothing drove it, so it could have been
 *      deleted without a single test going red.
 *   3. the activation gates against the REAL vendored flag-day twins on a
 *      regtest hub, rather than against the stubbed predicates every other
 *      bridge test installs.
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');

const CrossChainBridgeEngine = require('../../src/CrossChainBridgeEngine.js');
const Database               = require('../../src/db.js');

// A Database over a recording driver: every statement the engine issues is kept, so a test
// can assert that a refusal wrote NOTHING rather than that a stub was not called.
function memDb(){
    const calls = [];
    const db = Object.create(Database.prototype);
    db.calls = calls;
    db.doQuery = async function(sql, params){
        calls.push({ sql, params: params || [] });
        if(sql.startsWith('SELECT DISTINCT tick, src_chain, dest_chain')) return [];
        if(sql.startsWith('SELECT tick, dest_chain, amount FROM bridge_transfers')) return [];
        if(sql.startsWith('SELECT MAX(policy_seq)')) return [{ seq: 0 }];
        return [];
    };
    db.getChainTip = async () => ({ chainId: 'f'.repeat(64) });
    return db;
}

function makeEngine(opts){
    opts = opts || {};
    const db  = memDb();
    const hub = {
        db,
        network: opts.network || 'regtest',
        p2pConfig: { BTC_INDEXER_URL: 'http://btc', DOGE_INDEXER_URL: 'http://doge', LTC_INDEXER_URL: 'http://ltc' },
        hubDbBroadcaster: { broadcastRow: sinon.stub(), broadcastDeletion: sinon.stub() },
        capabilitySnapshot: opts.capSnapshot || null,
        getPeerManager: () => null,
        getIdentity:    () => null,
        _resolveBtcLatestBlock: async () => 150
    };
    const engine = new CrossChainBridgeEngine(hub);
    const stub = () => ({ propose: sinon.stub().resolves(), start: sinon.stub(), stop: sinon.stub(),
                          on: () => {}, forgetFinalized: sinon.stub() });
    engine.transferConsensus = stub();
    engine.policyConsensus   = stub();
    return { engine, db, hub };
}

describe('CrossChainBridgeEngine: chain-state wiring, the truncation refusal, and the live gates', function(){

    afterEach(function(){ sinon.restore(); });

    // -------------------------------------------------------------------------
    describe('getbridgebalances is the chain half of getbridgeinvariant', function(){

        // The whole point of the wiring: one JSON-RPC call per (chain, tick), on the same
        // per-chain client the pending poll uses, and no second name for the read.
        it('asks every chain that carries the tick, by name, through the indexer client', async function(){
            const { engine } = makeEngine();
            const seen = [];
            engine._indexerCall = async (coin, method, params) => {
                seen.push([coin, method, params.tick]);
                return { supply: '0', escrow: {} };
            };
            await engine.getBridgeInvariant('XCHAIN');
            expect(seen).to.deep.equal([
                ['BTC',  'getbridgebalances', 'XCHAIN'],
                ['LTC',  'getbridgebalances', 'XCHAIN'],
                ['DOGE', 'getbridgebalances', 'XCHAIN']
            ]);
        });

        // supply on the copy, escrow on the origin. Reading both halves on the copy is what
        // the first cut's injected-reader contract implied, and it would report every healthy
        // bridge as a deficit of its entire supply.
        it('reads supply on the copy and the backing escrow on the origin', async function(){
            const { engine } = makeEngine();
            engine._indexerCall = async (coin) => {
                if(coin === 'BTC')  return { supply: '30', escrow: { DOGE: '10', LTC: '7' } };
                if(coin === 'DOGE') return { supply: '10', escrow: {} };
                return { supply: '7', escrow: {} };
            };
            const inv = await engine.getBridgeInvariant('XCHAIN');
            expect(inv.XCHAIN.DOGE.escrow).to.equal('10');
            expect(inv.XCHAIN.DOGE.supply).to.equal('10');
            expect(inv.XCHAIN.DOGE.delta).to.equal('0');
            expect(inv.XCHAIN.LTC.escrow).to.equal('7');
            expect(inv.XCHAIN.LTC.delta).to.equal('0');
            // The origin: it holds the asset, nothing escrows it there.
            expect(inv.XCHAIN.BTC.supply).to.equal('30');
            expect(inv.XCHAIN.BTC.escrow).to.equal(null);
            expect(inv.XCHAIN.BTC.delta).to.equal(null);
        });

        // The indexer keys the map by the role address it read.
        it('accepts the escrow map keyed by the role name as well as by the coin', async function(){
            const { engine } = makeEngine();
            engine._indexerCall = async (coin) =>
                (coin === 'BTC' ? { supply: '5', escrow: { BRIDGE_DOGE: '5' } } : { supply: '5', escrow: {} });
            const inv = await engine.getBridgeInvariant('XCHAIN');
            expect(inv.XCHAIN.DOGE.escrow).to.equal('5');
            expect(inv.XCHAIN.DOGE.delta).to.equal('0');
        });

        it('counts in-flight against the escrow before judging the delta', async function(){
            const { engine } = makeEngine();
            engine._pendingInFlight = new Map([['XCHAIN|DOGE', ['4']]]);
            engine._indexerCall = async (coin) =>
                (coin === 'BTC' ? { supply: '4', escrow: { DOGE: '4' } } : { supply: '0', escrow: {} });
            const inv = await engine.getBridgeInvariant('XCHAIN');
            expect(inv.XCHAIN.DOGE.in_flight).to.equal('4');
            expect(inv.XCHAIN.DOGE.delta).to.equal('0');
        });

        // The failure this degradation exists for: the indexer half of the read lands on the
        // same train, so a hub rolled first sees "method not found" on every chain.
        it('degrades to null with one logged line when the method is absent', async function(){
            const { engine } = makeEngine();
            const warn = sinon.stub(console, 'warn');
            engine._indexerCall = async () => { throw new Error('indexer RPC error: {"code":-32601}'); };
            const inv = await engine.getBridgeInvariant('XCHAIN');
            expect(inv.XCHAIN.DOGE.escrow).to.equal(null);
            expect(inv.XCHAIN.DOGE.supply).to.equal(null);
            expect(inv.XCHAIN.DOGE.delta).to.equal(null);
            // in_flight is the half the hub proves from its own ledger and never degrades.
            expect(inv.XCHAIN.DOGE.in_flight).to.equal('0');
            const lines = warn.getCalls().map(c => String(c.args[0])).filter(s => s.includes('getbridgebalances'));
            expect(lines.length).to.equal(3);      // one per chain, never one per poll
            // A second read over the same unreadable chains stays silent.
            await engine.getBridgeInvariant('XCHAIN');
            expect(warn.getCalls().map(c => String(c.args[0]))
                       .filter(s => s.includes('getbridgebalances')).length).to.equal(3);
        });

        it('one unreachable chain does not take the readable ones out of the answer', async function(){
            const { engine } = makeEngine();
            sinon.stub(console, 'warn');
            engine._indexerCall = async (coin) => {
                if(coin === 'DOGE') throw new Error('ECONNREFUSED');
                if(coin === 'BTC')  return { supply: '9', escrow: { DOGE: '9', LTC: '0' } };
                return { supply: '0', escrow: {} };
            };
            const inv = await engine.getBridgeInvariant('XCHAIN');
            expect(inv.XCHAIN.DOGE.supply).to.equal(null);   // its own read failed
            expect(inv.XCHAIN.DOGE.delta).to.equal(null);    // so no delta can be signed
            expect(inv.XCHAIN.LTC.escrow).to.equal('0');     // BTC still answered for LTC
            expect(inv.XCHAIN.LTC.delta).to.equal('0');
        });

        // A token's origin is learned from the pending read's transfer_kind. Until it is
        // known the hub must not read a backing balance off a chain that holds no escrow.
        it('leaves escrow null for a token whose origin this hub has not learned yet', async function(){
            const { engine, db } = makeEngine();
            db.doQuery = async (sql) => {
                if(sql.startsWith('SELECT DISTINCT tick, src_chain, dest_chain'))
                    return [{ tick: 'FUFU', src_chain: 'DOGE', dest_chain: 'LTC' }];
                if(sql.startsWith('SELECT MAX(policy_seq)')) return [{ seq: 0 }];
                return [];
            };
            engine._indexerCall = async () => ({ supply: '3', escrow: { LTC: '3', DOGE: '3' } });
            let inv = await engine.getBridgeInvariant('FUFU');
            expect(inv.FUFU.LTC.supply).to.equal('3');
            expect(inv.FUFU.LTC.escrow).to.equal(null);
            expect(inv.FUFU.LTC.delta).to.equal(null);

            // Once the poll has learned it, the same read resolves the backing balance.
            engine._tickOrigin.set('regtest|FUFU', 'DOGE');
            inv = await engine.getBridgeInvariant('FUFU');
            expect(inv.FUFU.LTC.escrow).to.equal('3');
            expect(inv.FUFU.LTC.delta).to.equal('0');
        });

        // The injection point survives the wiring: an operator tool or a test can still
        // replace the whole reader, and when it does the indexer is never called.
        it('an injected chainStateReader replaces the indexer read entirely', async function(){
            const { engine } = makeEngine();
            engine._indexerCall = sinon.stub().rejects(new Error('the injected reader must win'));
            engine.chainStateReader = async (coin) =>
                (coin === 'BTC' ? { XCHAIN: { supply: '2', escrow: { DOGE: '2' } } } : { XCHAIN: { supply: '2', escrow: {} } });
            const inv = await engine.getBridgeInvariant('XCHAIN');
            expect(engine._indexerCall.called).to.equal(false);
            expect(inv.XCHAIN.DOGE.escrow).to.equal('2');
        });
    });

    // -------------------------------------------------------------------------
    describe('the TRUNCATED capability-snapshot refusal', function(){

        // A truncated set is a JS array property with no column behind it, so persisting the
        // capped rows would let an off-BTC verifier read a partial set as COMPLETE.
        it('refuses to persist a truncated set, writes no rows and returns the fail-closed 0', async function(){
            const { engine, db, hub } = makeEngine({
                capSnapshot: {
                    async getSnapshot(){
                        return { validators: [{ pubkey: 'a'.repeat(64), amount: '1' },
                                              { pubkey: 'b'.repeat(64), amount: '1' }], truncated: true };
                    },
                    async getWeightSnapshot(){
                        return { validators: [{ pubkey: 'a'.repeat(64), source: 's1', weight: '1' }],
                                 count: 1, sourceCount: 1, truncated: true };
                    }
                }
            });
            const warn = sinon.stub(console, 'warn');
            const before = db.calls.length;

            const persisted = await engine._persistCapabilitySnapshot('cross_chain', 150, 'regtest');

            expect(persisted).to.equal(0);
            const wrote = db.calls.slice(before).filter(c => /capability_snapshots/i.test(c.sql));
            expect(wrote).to.deep.equal([], 'a truncated set must mirror nothing at all');
            expect(hub.hubDbBroadcaster.broadcastRow.called).to.equal(false);
            expect(warn.getCalls().map(c => String(c.args[0]))
                       .some(s => s.includes('TRUNCATED') && s.includes('cross_chain'))).to.equal(true);
        });

        // The other half of the same rule: an untruncated set of the same size DOES persist,
        // so the refusal is keyed on the marker and not on "this test stubs writes away".
        it('persists the same set when it is not truncated', async function(){
            const { engine, db } = makeEngine({
                capSnapshot: {
                    async getSnapshot(){
                        return { validators: [{ pubkey: 'a'.repeat(64), amount: '1' },
                                              { pubkey: 'b'.repeat(64), amount: '1' }] };
                    },
                    async getWeightSnapshot(){
                        return { validators: [{ pubkey: 'a'.repeat(64), source: 's1', weight: '1' }],
                                 count: 1, sourceCount: 1 };
                    }
                }
            });
            const before = db.calls.length;
            const persisted = await engine._persistCapabilitySnapshot('cross_chain', 150, 'regtest');
            expect(persisted).to.be.above(0);
            expect(db.calls.slice(before).filter(c => /capability_snapshots/i.test(c.sql)).length).to.be.above(0);
        });
    });

    // -------------------------------------------------------------------------
    describe('the vendored flag-day twins on a regtest hub', function(){

        // No stubbed predicates here: this is the real require of the three activation
        // modules beside the engine, which is what a regtest stack actually boots with.
        it('_gateActive is true for all three families at every regtest height', function(){
            const { engine } = makeEngine({ network: 'regtest' });
            expect(typeof engine.activation.bridge).to.equal('function');
            expect(typeof engine.activation.token).to.equal('function');
            expect(typeof engine.activation.policy).to.equal('function');
            for(const block of [0, 1, 150, 1000000]){
                expect(engine._gateActive('bridge', block), 'bridge at ' + block).to.equal(true);
                expect(engine._gateActive('token',  block), 'token at '  + block).to.equal(true);
                expect(engine._gateActive('policy', block), 'policy at ' + block).to.equal(true);
            }
        });

        // The same real twins on mainnet: the house sentinel is not armed, so a hub that
        // somehow ran this build against mainnet signs nothing. Pre-activation replay hashes
        // cannot move if the engine never polls.
        it('the same twins leave every family closed on mainnet', function(){
            const { engine } = makeEngine({ network: 'mainnet' });
            expect(engine._gateActive('bridge', 1000000)).to.equal(false);
            expect(engine._gateActive('token',  1000000)).to.equal(false);
            expect(engine._gateActive('policy', 1000000)).to.equal(false);
        });

        // Armed gates plus a regtest config: the poll actually reaches the indexer.
        it('a regtest hub with the real gates polls instead of idling', async function(){
            const { engine } = makeEngine({ network: 'regtest' });
            engine._indexerCall = sinon.stub().resolves({ latest_block_index: 200, network: 'regtest', transfers: [] });
            await engine._poll();
            expect(engine._indexerCall.called).to.equal(true);
            expect(engine._indexerCall.getCalls().some(c => c.args[1] === 'getpendingbridgetransfers')).to.equal(true);
        });
    });
});
