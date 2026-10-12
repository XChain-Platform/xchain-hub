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

const { expect } = require('chai');
const sinon = require('sinon');

const CrossChainBridgeEngine = require('../../../../src/cross_chain/bridge_engine.js');
const viewChangePart = require('../../../../src/cross_chain/pbft/view_change.js');
const bridgeValidatePart = require('../../../../src/cross_chain/bridge/validate.js');
const { relayMarginFloorS } = require('../../../../src/lib/relay_margin.js');
const { getRegistry, getLogger } = require('../../../../src/observability');

const CURRENT_SECOND = 1700000240;
const RID = 'a'.repeat(64);
const SELF = 'b'.repeat(66);

function canonical(row, view){
    return JSON.stringify({ row, view });
}

function buildEngine(clock, engineParts){
    let hub = {
        db: {},
        network: 'regtest',
        p2pConfig: {
            BTC_INDEXER_URL: 'http://btc',
            DOGE_INDEXER_URL: 'http://doge',
            LTC_INDEXER_URL: 'http://ltc'
        },
        getPeerManager: () => null,
        getIdentity: () => null
    };
    let engine = new CrossChainBridgeEngine(hub);
    engine.nowSeconds = () => clock.value;
    engine.canonicalMatch = canonical;
    return Object.assign(engine, engineParts);
}

function buildConsensus(row, engineParts){
    let proposed = [];
    let clock = { value: CURRENT_SECOND };
    let pending = {
        matchId: RID,
        startedAt: CURRENT_SECOND * 1000,
        row,
        canonical: canonical(row, 0),
        validators: [{ pubkey: SELF }],
        view: 0,
        myPubkey: SELF,
        viewChanges: new Map([[2, new Set([SELF])]]),
        signatures: new Map([['old', 'signature']]),
        prepares: new Set(['old']),
        commits: new Set(['old']),
        _commitSent: true,
        finalized: false
    };
    let engine = buildEngine(clock, engineParts);
    let consensus = Object.assign({
        pending: new Map([[RID, pending]]),
        engine,
        meetsQuorum: () => true,
        leaderFor: () => SELF,
        peerManager: null,
        broadcastPropose: (p) => {
            proposed.push({ row: Object.assign({}, p.row), canonical: p.canonical });
            return Promise.resolve();
        }
    }, viewChangePart);
    return { consensus, pending, proposed, clock, engine };
}

async function passesBridgeValidation(row){
    let validator = Object.assign({}, bridgeValidatePart, {
        nowSeconds: () => CURRENT_SECOND,
        resolveSnapshotBlock: async () => row.snapshot_block,
        gateActive: () => true,
        validateTransfer: async () => true,
        validatePolicy: async () => true
    });
    return validator.validateProposedMatch(row);
}

describe('PBFT view-change effective-time restamping', function(){
    it('uses the transfer stamping margin when a stale row is re-proposed', async function(){
        let row = {
            transfer_id: RID,
            snapshot_block: 100,
            network: 'regtest',
            effective_time: CURRENT_SECOND,
            dest_chain: 'DOGE'
        };
        let margin = relayMarginFloorS(row.dest_chain);
        let { consensus, pending, proposed, clock, engine } = buildConsensus(row);

        expect(CrossChainBridgeEngine.prototype.effectiveTimeMarginS).to.be.a('function');
        expect(engine).to.be.an.instanceof(CrossChainBridgeEngine);
        expect(await passesBridgeValidation(Object.assign({}, row))).to.equal(false);
        await consensus.maybeAssumeLeadership(RID, 2);

        expect(row.effective_time).to.equal(CURRENT_SECOND + margin);
        expect(await passesBridgeValidation(proposed[0].row)).to.equal(true);
        expect(pending.signatures.size).to.equal(0);
        expect(pending.prepares.size).to.equal(0);
        expect(pending.commits.size).to.equal(0);
        expect(pending._commitSent).to.equal(false);

        clock.value = CURRENT_SECOND + margin;
        pending.viewChanges.set(4, new Set([SELF]));
        await consensus.maybeAssumeLeadership(RID, 4);
        expect(row.effective_time).to.equal(CURRENT_SECOND + (2 * margin));
    });

    it('uses the policy stamping margin for the row copy set', async function(){
        let row = {
            snapshot_id: RID,
            snapshot_block: 100,
            network: 'regtest',
            effective_time: CURRENT_SECOND,
            origin_chain: 'DOGE',
            tick: 'POLICY'
        };
        let copies = new Set(['DOGE', 'LTC']);
        let engineParts = {
            policyPairs: async () => [{ origin_chain: row.origin_chain, tick: row.tick, copies }]
        };
        let { consensus, engine } = buildConsensus(row, engineParts);
        let margin = engine.policyMarginS(copies, row.origin_chain);

        await consensus.maybeAssumeLeadership(RID, 2);

        expect(margin).to.equal(relayMarginFloorS('LTC'));
        expect(row.effective_time).to.equal(CURRENT_SECOND + margin);
    });
});

describe('PBFT view-change effective-time restamping guards', function(){
    it('does not restamp a row that still clears the follower floor', async function(){
        let row = {
            transfer_id: RID,
            snapshot_block: 100,
            network: 'regtest',
            effective_time: CURRENT_SECOND + 61,
            dest_chain: 'DOGE'
        };
        let { consensus } = buildConsensus(row);

        await consensus.maybeAssumeLeadership(RID, 2);

        expect(row.effective_time).to.equal(CURRENT_SECOND + 61);
    });

    it('leaves a row without effective_time untouched', async function(){
        let row = { match_id: RID, snapshot_block: 100, network: 'regtest' };
        let before = Object.assign({}, row);
        let { consensus } = buildConsensus(row);

        await consensus.maybeAssumeLeadership(RID, 2);

        expect(row).to.deep.equal(before);
        expect(Object.prototype.hasOwnProperty.call(row, 'effective_time')).to.equal(false);
    });

    it('still re-proposes a stale row for an engine with no margin reader', async function(){
        let row = { transfer_id: RID, snapshot_block: 100, network: 'regtest',
                    effective_time: CURRENT_SECOND, dest_chain: 'DOGE' };
        let { consensus, proposed } = buildConsensus(row, { effectiveTimeMarginS: undefined });
        let before = restampFailures('missing') + restampFailures('invalid');

        await consensus.maybeAssumeLeadership(RID, 2);

        expect(proposed).to.have.length(1);
        expect(row.effective_time).to.equal(CURRENT_SECOND);
        expect(restampFailures('missing') + restampFailures('invalid')).to.equal(before);
    });
});

function restampFailures(reason){
    let line = getRegistry().render().split('\n')
        .find(l => l.startsWith('xchain_pbft_restamp_failures_total{reason="' + reason + '"}'));
    return line ? Number(line.trim().split(' ').pop()) : 0;
}

function stalePolicyRow(){
    return { snapshot_id: RID, snapshot_block: 100, network: 'regtest',
             effective_time: CURRENT_SECOND, origin_chain: 'DOGE', tick: 'POLICY' };
}

// A failed restamp is counted and holds NEW_VIEW and PROPOSE, leaving the round's votes
// and its stale row for the round timer; a later view with a readable margin proceeds.
describe('PBFT view-change effective-time restamp failures', function(){
    registerAsyncRestampFailures();
    registerSyncRestampFailures();
    registerRestampRecovery();
});

function registerAsyncRestampFailures(){
    it('holds the re-proposal when the row\'s policy pair is absent', async function(){
        let row = stalePolicyRow();
        let { consensus, pending, proposed } = buildConsensus(row, { policyPairs: async () => [] });
        let before = restampFailures('missing');

        await consensus.maybeAssumeLeadership(RID, 2);

        expect(restampFailures('missing')).to.equal(before + 1);
        expect(proposed).to.have.length(0);
        expect(row.effective_time).to.equal(CURRENT_SECOND);
        expect(pending.signatures.size).to.equal(1);
    });

    it('holds the re-proposal when the margin read rejects', async function(){
        let row = stalePolicyRow();
        let { consensus, proposed } = buildConsensus(row, {
            policyPairs: async () => { throw new Error('pool closed'); }
        });
        let before = restampFailures('rejected');

        let settled = await consensus.maybeAssumeLeadership(RID, 2);

        expect(settled).to.equal(undefined);
        expect(restampFailures('rejected')).to.equal(before + 1);
        expect(proposed).to.have.length(0);
    });
}

function registerSyncRestampFailures(){
    it('holds the re-proposal when the margin read throws synchronously', function(){
        let row = stalePolicyRow();
        let { consensus, proposed } = buildConsensus(row, {
            effectiveTimeMarginS(){ throw new Error('bad row'); }
        });
        let before = restampFailures('threw');

        expect(() => consensus.maybeAssumeLeadership(RID, 2)).to.not.throw();

        expect(restampFailures('threw')).to.equal(before + 1);
        expect(proposed).to.have.length(0);
    });

    for(let bad of [0, -5, NaN, 'soon']){
        it('holds the re-proposal on the unusable margin ' + String(bad), function(){
            let row = stalePolicyRow();
            let { consensus, proposed } = buildConsensus(row, { effectiveTimeMarginS: () => bad });
            let before = restampFailures('invalid');

            consensus.maybeAssumeLeadership(RID, 2);

            expect(restampFailures('invalid')).to.equal(before + 1);
            expect(proposed).to.have.length(0);
            expect(row.effective_time).to.equal(CURRENT_SECOND);
        });
    }
}

function registerRestampRecovery(){
    it('re-proposes at a later view once the pair is readable again', async function(){
        let row = stalePolicyRow();
        let pairs = [];
        let copies = new Set(['DOGE', 'LTC']);
        let { consensus, proposed, engine } = buildConsensus(row, { policyPairs: async () => pairs });

        await consensus.maybeAssumeLeadership(RID, 2);
        expect(proposed).to.have.length(0);

        pairs = [{ origin_chain: row.origin_chain, tick: row.tick, copies }];
        consensus.pending.get(RID).viewChanges.set(4, new Set([SELF]));
        await consensus.maybeAssumeLeadership(RID, 4);

        expect(proposed).to.have.length(1);
        expect(row.effective_time).to.equal(CURRENT_SECOND + engine.policyMarginS(copies, row.origin_chain));
    });

    it('warns when the policy pair read degrades to the pending legs on a DB error', async function(){
        let engine = buildEngine({ value: CURRENT_SECOND });
        engine.db = { getBridgeTransferChainPairs: async () => { throw new Error('pool closed'); } };
        engine._tickOrigin = new Map([['regtest|POLICY', 'DOGE']]);
        engine._pendingInFlight = new Map([['POLICY|LTC', ['1']]]);
        // The module logger is the shared lazy one, so stub it rather than console, which an
        // installed log shipper bypasses.
        let warns = [];
        let warn = sinon.stub(getLogger(), 'warn').callsFake(m => warns.push(String(m)));
        let pairs;
        try { pairs = await engine.policyPairs('regtest'); }
        finally { warn.restore(); }

        expect(pairs.map(p => p.origin_chain + ':' + p.tick)).to.deep.equal(['DOGE:POLICY']);
        expect(warns.filter(m => /transfer chain-pair read failed for regtest.*pool closed/.test(m))).to.have.length(1);
    });
}
