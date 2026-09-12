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
//
// test/unit/anchorRewardActivationParity.test.js
//
// src/anchor_reward_activation.js is a TWIN: the indexer carries the same file and
// xchain-documentation/protocol/constants.js carries the same values. The header claims
// that parity and, until this file, only the INDEXER side enforced it, so a one-sided edit
// made on the hub could ship green. The hub is the side that signs, which makes it the
// worse side to leave unguarded: it would stamp rows under a flag day its consumers do not
// share and nothing on this repo would say so.
//
// The maturity-horizon member (anchor-attest-barrier-future-block.md section 8) is included
// with the rest, and its predicate is DRIVEN here rather than described, because the
// `0 >= null` trap it guards is a silent arm rather than a crash.

const { expect } = require('chai');
const fs   = require('fs');
const path = require('path');

const LOCAL_PATH   = path.resolve(__dirname, '../../src/anchor_reward_activation.js');
const TWIN_PATH    = path.resolve(__dirname, '../../../xchain-indexer/src/anchor_reward_activation.js');
const CANON_PATH   = path.resolve(__dirname, '../../../xchain-documentation/protocol/constants.js');

const local = require(LOCAL_PATH);

// The one line the two copies are ALLOWED to differ on: each names the other as its twin.
// Everything else must be byte-equal, so the exemption is stated as an exact pair rather
// than as a fuzzy tolerance a real drift could hide inside.
const HEADER_SELF_REF = {
    hub:     ' * xchain-indexer/src/anchor_reward_activation.js and in',
    indexer: ' * xchain-hub/src/anchor_reward_activation.js and in'
};

describe('anchor_reward_activation parity (hub copy)', function () {

    it('is byte-identical to the indexer twin apart from the self-referencing header line', function () {
        if (!fs.existsSync(TWIN_PATH)) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('xchain-indexer sibling checkout missing: ' + TWIN_PATH);
            this.skip();
            return;
        }
        const mine   = fs.readFileSync(LOCAL_PATH, 'utf8').split('\n');
        const theirs = fs.readFileSync(TWIN_PATH, 'utf8').split('\n');
        expect(mine.length, 'the twins differ in line count; something was added on one side only')
            .to.equal(theirs.length);
        const differing = [];
        for (let i = 0; i < mine.length; i++) if (mine[i] !== theirs[i]) differing.push(i + 1);
        // Exactly one line may differ, and it must be the known self-reference pair.
        expect(differing, 'lines that differ between the hub and indexer copies').to.have.lengthOf(1);
        const n = differing[0] - 1;
        expect(mine[n]).to.equal(HEADER_SELF_REF.hub);
        expect(theirs[n]).to.equal(HEADER_SELF_REF.indexer);
    });

    it('is value-identical to the canonical constants.js for every export canon carries', function () {
        if (!fs.existsSync(CANON_PATH)) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('xchain-documentation sibling checkout missing: ' + CANON_PATH);
            this.skip();
            return;
        }
        const canon = require(CANON_PATH);
        const PINNED = [
            'ANCHOR_REWARD_ACTIVATION', 'ANCHOR_REWARD_AMOUNT', 'ARCHIVE_REWARD_AMOUNT',
            'ANCHOR_REWARD_DERIVE_ACTIVATION', 'ANCHOR_REWARD_MIRROR_MATURITY',
            'ANCHOR_ATTEST_ARRIVAL_MARGIN_S', 'ANCHOR_ATTEST_BARRIER_ACTIVATION'
        ];
        for (const name of PINNED) {
            expect(local[name], 'the hub copy must export ' + name).to.not.equal(undefined);
            expect(canon[name], 'constants.js must export ' + name + ' (the canonical authority)').to.not.equal(undefined);
            expect(local[name], name + ' has drifted from the canonical value; a one-sided flag-day ' +
                'edit forks consensus at the boundary').to.deep.equal(canon[name]);
        }
    });

    // The margin is 18 h and the reason is measured: the hub's write-lag envelope is ~15 h
    // (checkpoint age at flush, the publisher's 6 h deferred-write queue TTL, a receiver hub's
    // re-proof through that same queue, and raw-stamp skew). The earlier 21600 s figure sat
    // BELOW that queue TTL, which is why a bare "some margin" here would not be a guard at all.
    it('keeps the arrival margin above the publisher\'s own deferred-write queue TTL', function () {
        const QUEUE_TTL_S = 6 * 3600;
        expect(local.ANCHOR_ATTEST_ARRIVAL_MARGIN_S).to.equal(64800);
        expect(local.ANCHOR_ATTEST_ARRIVAL_MARGIN_S).to.be.above(QUEUE_TTL_S,
            'a margin at or below the 6 h queue TTL certifies completeness the hub cannot deliver');
        // And it still opens earlier than a nominal 144-block span, so the barrier can only
        // ever open EARLIER than today's wait, never later.
        expect(local.ANCHOR_ATTEST_ARRIVAL_MARGIN_S).to.be.below(144 * 600);
    });
});

describe('anchor_reward_activation: isAnchorAttestBarrierHorizonActive (the 0 >= null trap)', function () {

    it('holds an INERT network inert at height 0 and at a huge height', function () {
        for (const net of ['mainnet', 'testnet']) {
            expect(local.ANCHOR_ATTEST_BARRIER_ACTIVATION[net],
                'not vacuous: ' + net + ' must still be the inert null this case is about').to.equal(null);
            for (const h of [0, 1, 999999999, Number.MAX_SAFE_INTEGER]) {
                expect(local.isAnchorAttestBarrierHorizonActive(net, h),
                    net + ' armed at height ' + h + ' despite an inert (null) threshold').to.equal(false);
            }
        }
    });

    it('reads an unknown network as INERT, never as armed', function () {
        for (const net of ['signet', '', null, undefined, 'toString', 'constructor']) {
            expect(local.isAnchorAttestBarrierHorizonActive(net, 0)).to.equal(false);
            expect(local.isAnchorAttestBarrierHorizonActive(net, 1000000)).to.equal(false);
        }
    });

    // Driven on an ARMED copy, because on an inert map every height is false for the other
    // reason and the height guard would never be reached.
    it('arms at and above the threshold, and never on an unreadable height', function () {
        const MODULE_PATH = require.resolve(LOCAL_PATH);
        const MIRROR_PATH = require.resolve(path.resolve(__dirname, '../../src/mirror_admission_activation.js'));
        const savedEnv    = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        const savedLocal  = require.cache[MODULE_PATH];
        const savedMirror = require.cache[MIRROR_PATH];
        try {
            process.env.XC_MIRROR_ADMISSION_ACTIVATION = '150';
            delete require.cache[MODULE_PATH];
            delete require.cache[MIRROR_PATH];
            const armed = require(LOCAL_PATH);
            expect(armed.ANCHOR_ATTEST_BARRIER_ACTIVATION.regtest,
                'not vacuous: the shared venue lever must arm regtest at 150').to.equal(150);
            expect(armed.isAnchorAttestBarrierHorizonActive('regtest', 149)).to.equal(false);
            expect(armed.isAnchorAttestBarrierHorizonActive('regtest', 150)).to.equal(true, 'the edge is inclusive');
            expect(armed.isAnchorAttestBarrierHorizonActive('regtest', 151)).to.equal(true);
            expect(armed.isAnchorAttestBarrierHorizonActive('regtest', '150')).to.equal(true, 'a numeric string is a height');
            for (const h of [NaN, undefined, null, Infinity, 'later', {}])
                expect(armed.isAnchorAttestBarrierHorizonActive('regtest', h),
                    'an unreadable height armed the barrier').to.equal(false);
            // The armed lever must NOT reach the held networks.
            expect(armed.isAnchorAttestBarrierHorizonActive('mainnet', 150)).to.equal(false);
            expect(armed.isAnchorAttestBarrierHorizonActive('testnet', 150)).to.equal(false);
        } finally {
            if (savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
            else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
            require.cache[MODULE_PATH] = savedLocal;
            require.cache[MIRROR_PATH] = savedMirror;
        }
    });

    // ONE venue lever arms BOTH flag days. A drill that armed the admission axis while leaving
    // the horizon inert would rehearse a split the fleet is never supposed to be in.
    it('shares the family\'s arming seam, so one venue lever arms both flag days', function () {
        const MODULE_PATH = require.resolve(LOCAL_PATH);
        const MIRROR_PATH = require.resolve(path.resolve(__dirname, '../../src/mirror_admission_activation.js'));
        const savedEnv    = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        const savedLocal  = require.cache[MODULE_PATH];
        const savedMirror = require.cache[MIRROR_PATH];
        try {
            process.env.XC_MIRROR_ADMISSION_ACTIVATION = 'armed';
            delete require.cache[MODULE_PATH];
            delete require.cache[MIRROR_PATH];
            const armed  = require(LOCAL_PATH);
            const family = require(MIRROR_PATH);
            expect(armed.isAnchorAttestBarrierHorizonActive('regtest', 0)).to.equal(true);
            expect(family.isMirrorAdmissionProducerActive('BTC', 'regtest', 0)).to.equal(true);
            expect(family.isMirrorAdmissionConsumerActive('BTC', 'regtest', 0)).to.equal(true);
        } finally {
            if (savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
            else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
            require.cache[MODULE_PATH] = savedLocal;
            require.cache[MIRROR_PATH] = savedMirror;
        }
    });
});
