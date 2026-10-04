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

const sinon             = require('sinon');
const OracleConsensus   = require('../../../../../../src/oracle/consensus');
const { createMockHub } = require('../../../../../helpers/mockHub');
const {
    VALIDATORS_3,
    buildUniformSubmissions,
    makeCapabilitySnapshotStub
} = require('../../../../../helpers/fixtures');

const BLOCK_HEIGHT = 100;
const PRICES = [{ coinPair: 'BTC/USD', price: '100000' }];

function makeProposeTimeHarness({ network, round, epochStart, roundInterval, nowMs }) {
    let clock = sinon.useFakeTimers({ now: nowMs });
    let hub = createMockHub({ network: network });
    let oracleRound = {
        epochStart:    Number(epochStart),
        roundInterval: Number(roundInterval),
        getSubmissions: sinon.stub().returns(buildUniformSubmissions(VALIDATORS_3, PRICES))
    };
    hub.resolveBtcLatestBlock = sinon.stub().resolves(BLOCK_HEIGHT);
    hub.capabilitySnapshot = makeCapabilitySnapshotStub(VALIDATORS_3);
    let snapshotRead = sinon.spy(hub.capabilitySnapshot, 'getSnapshot');
    let oc = new OracleConsensus(hub, oracleRound);
    oc.setValidatorSet(VALIDATORS_3);

    let leader = oc.getLeader(round);
    let follower = VALIDATORS_3.find(v => v.addr !== leader.addr);
    hub._peerManager.validatorAddr = follower.addr;
    hub._peerManager.validatorPubkeys = new Map(VALIDATORS_3.map(v => [v.addr, v.pubkey]));
    hub._identity.getPubkeyHex.returns(follower.pubkey);

    async function deliver({ btcBlockTime, omitTime, badDigest } = {}) {
        let callsBefore = snapshotRead.callCount;
        let digest = oc.digest(round, PRICES);
        let data = {
            round:          round,
            prices:         PRICES,
            digest:         badDigest ? 'bad-' + digest : digest,
            btcBlockHeight: BLOCK_HEIGHT
        };
        if (!omitTime) data.btcBlockTime = btcBlockTime;

        await oc.handlePropose({
            sender:     leader.addr,
            sig_pubkey: leader.pubkey,
            data:       data
        });
        let pending = oc.pendingRounds.get(round);
        return {
            reachedSnapshot: snapshotRead.callCount > callsBefore,
            pendingTime:     pending ? pending.btcBlockTime : null
        };
    }

    function restore() {
        for (let pending of oc.pendingRounds.values()) {
            if (pending.timer) clearTimeout(pending.timer);
        }
        for (let watchdog of oc.roundWatchdogs.values()) {
            if (watchdog && watchdog.timer) clearTimeout(watchdog.timer);
        }
        for (let timer of oc.leaderTimers.values()) clearTimeout(timer);
        oc.pendingRounds.clear();
        oc.roundWatchdogs.clear();
        oc.leaderTimers.clear();
        clock.restore();
        sinon.restore();
    }

    return { oc, deliver, restore };
}

module.exports = { makeProposeTimeHarness };
