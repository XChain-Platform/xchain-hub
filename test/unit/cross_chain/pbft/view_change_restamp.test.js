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

const CrossChainBridgeEngine = require('../../../../src/cross_chain/bridge_engine.js');
const viewChangePart = require('../../../../src/cross_chain/pbft/view_change.js');
const bridgeValidatePart = require('../../../../src/cross_chain/bridge/validate.js');
const { relayMarginFloorS } = require('../../../../src/lib/relay_margin.js');

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
});
