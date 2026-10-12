'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// The audit-row fallback for a peer the registry has no row for must say WHY it
// dropped the row. A stake-feed fault is counted and named as one; only a key the
// resolved snapshot does not carry earns the "call syncvalidators" remedy.

const sinon      = require('sinon');
const { expect } = require('chai');

const OracleRound       = require('../../../../src/oracle/round');
const StakeWeightFeed   = require('../../../../src/validators/stake_weight_feed');
const { createMockHub } = require('../../../helpers/mockHub');
const { makeValidator } = require('../../../helpers/fixtures');

const BLOCK  = 150200;
const ROUND  = 4242;
const MEMBER = makeValidator(1);
const PRICES = [{ coinPair: 'BTC/USD', price: '100000.00000000', sources: 2 }];

const UNREGISTERED = /skipping DB persist for unregistered sender/;
const FEED_FAULT   = /registering the peer will not help/;

let hub, oracle, warn;

// Warnings matching a pattern, as text, so a regression prints the line itself.
function warnLines(pattern) {
    return warn.getCalls().map(c => c.args.map(String).join(' ')).filter(l => pattern.test(l));
}

// Route the feed's snapshot read through `getWeightSnapshot`.
function feedOver(getWeightSnapshot) {
    hub.capabilitySnapshot = { getWeightSnapshot: getWeightSnapshot };
    hub.stakeWeightFeed = new StakeWeightFeed(hub);
}

function persist() {
    return oracle.persistFromStakeWeight(ROUND, { sender: MEMBER.addr }, PRICES, MEMBER.pubkey);
}

describe('OracleRound stake-weight audit fallback: fault versus unknown key', function () {

    beforeEach(function () {
        hub = createMockHub({ p2pConfig: { HUB_NETWORK: 'testnet' } });
        hub.network = 'testnet';
        warn = sinon.stub(console, 'warn');
        sinon.stub(console, 'log');
        sinon.stub(console, 'error');
        oracle = new OracleRound(hub);
        oracle.currentBtcBlockHeight = BLOCK;
        sinon.stub(oracle, 'persistSubmissions').resolves();
    });

    afterEach(function () { sinon.restore(); });

    registerFeedFaultTests();
    registerMembershipTests();
});

function registerFeedFaultTests() {

    it('counts an unavailable weight snapshot as a feed fault, not an unregistered sender', async function () {
        feedOver(sinon.stub().resolves(null));
        await persist();

        expect(warnLines(UNREGISTERED)).to.deep.equal([]);
        expect(warnLines(FEED_FAULT)).to.have.length(1);
        expect(oracle.stakeWeightLookupFailures).to.equal(1);
        expect(oracle.lastStakeWeightLookupFailureRound).to.equal(ROUND);
        expect(oracle.persistSubmissions.called).to.equal(false);
    });

    it('names the thrown lookup error and still never sends the operator to syncvalidators', async function () {
        feedOver(sinon.stub().resolves(null));
        sinon.stub(hub.stakeWeightFeed, 'membership').rejects(new Error('indexer socket reset'));
        await persist();

        expect(warnLines(UNREGISTERED)).to.deep.equal([]);
        expect(warnLines(/indexer socket reset/)).to.have.length(1);
        expect(oracle.stakeWeightLookupFailures).to.equal(1);
    });

    it('exposes the lookup-fault counter on the submissions diagnostics payload', async function () {
        feedOver(sinon.stub().resolves(null));
        await persist();

        let info = await oracle.getSubmissionsInfo();
        expect(info.stakeWeightLookupFailures).to.equal(1);
        expect(info.lastStakeWeightLookupFailureRound).to.equal(ROUND);
    });
}

function registerMembershipTests() {

    it('keeps the syncvalidators remedy for a key the resolved snapshot does not carry', async function () {
        feedOver(sinon.stub().resolves({ validators: [{ pubkey: makeValidator(2).pubkey }] }));
        await persist();

        expect(warnLines(UNREGISTERED)).to.have.length(1);
        expect(warnLines(FEED_FAULT)).to.deep.equal([]);
        expect(oracle.stakeWeightLookupFailures).to.equal(0);
    });

    it('counts a qualified peer whose persist throws as a persist failure, never as unregistered', async function () {
        feedOver(sinon.stub().resolves({ validators: [{ pubkey: MEMBER.pubkey }] }));
        oracle.persistSubmissions.rejects(new Error('pool closed'));
        await persist();

        expect(warnLines(UNREGISTERED)).to.deep.equal([]);
        expect(warnLines(FEED_FAULT)).to.deep.equal([]);
        expect(oracle.failedSubmissionPersists).to.equal(PRICES.length);
        expect(oracle.lastSubmissionPersistFailureRound).to.equal(ROUND);
        expect(oracle.stakeWeightLookupFailures).to.equal(0);
    });

    it('persists a qualified peer through the registered-sender path', async function () {
        feedOver(sinon.stub().resolves({ validators: [{ pubkey: MEMBER.pubkey }] }));
        await persist();

        expect(oracle.persistSubmissions.calledOnceWith(ROUND, MEMBER.addr, PRICES, MEMBER.pubkey)).to.equal(true);
        expect(warn.called).to.equal(false);
    });
}
