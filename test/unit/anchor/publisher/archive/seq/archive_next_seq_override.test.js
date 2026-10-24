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

// The regtest-only ANCHOR_ARCHIVE_NEXT_SEQ_OVERRIDE: on regtest every archive draw returns
// the pinned seq, past the row-derived seq, the federation floor and the own-address
// redraw, so a drill can lead a head under a seq this hub already spent. On testnet,
// mainnet and a standalone hub it is refused with ArchiveNextSeqOverrideNetworkError,
// both at the draw and at boot.

const { expect }           = require('chai');
const sinon                = require('sinon');
const StateAnchorPublisher = require('../../../../../../src/anchor/publisher');
const ValidatorIdentity    = require('../../../../../../src/validators/identity');
const { DB_METHODS }       = require('../../../../../helpers/mockHub.js');
const { refuseArchiveSeqOverride, refuseInvalidNetwork } = require('../../../../../../src/api/boot_guard.js');
const {
    NEXT_SEQ_OVERRIDE,
    ArchiveNextSeqOverrideNetworkError,
    ArchiveNextSeqOverrideValueError,
    resolveArchiveNextSeqOverride
} = require('../../../../../../src/anchor/publisher/archive/seq_override.js');

let savedEnv;

function setOverride(value) {
    if (value === undefined) delete process.env[NEXT_SEQ_OVERRIDE];
    else process.env[NEXT_SEQ_OVERRIDE] = value;
}

// A publisher on `network` whose rows give 300 as the next seq and whose federation
// floor and own DOGE address both sit above the seq the drill wants to reuse.
function mkPub(network) {
    const identity = new ValidatorIdentity('11'.repeat(32));
    const pub = new StateAnchorPublisher({
        db: { ...DB_METHODS, doQuery: async () => [] }, network, p2pConfig: {},
        getIdentity: () => identity,
        getPeerManager: () => ({ on(){}, removeListener(){}, broadcast(){} }),
        rewardTracker: { anchorReward: '10.00000000', resolveSourceByPubkey: async () => 'src' },
        resolveBtcLatestBlock: async () => 100
    });
    pub.db.getNextAnchorBatchSeq = sinon.stub().resolves([{ next_seq: 300 }]);
    pub.refreshOwnArchiveSeqFloor = async () => false;
    pub.noteOwnArchiveSeq(151);
    return pub;
}

function registerResolverTests() {
    describe('resolveArchiveNextSeqOverride', function () {
        it('is null when the override is unset or blank, on every network', function () {
            for (const network of ['regtest', 'testnet', 'mainnet', ''])
                for (const raw of [undefined, null, '', '  '])
                    expect(resolveArchiveNextSeqOverride(network, raw)).to.equal(null);
        });

        it('returns the pinned seq on regtest', function () {
            expect(resolveArchiveNextSeqOverride('regtest', '151')).to.equal(151);
            expect(resolveArchiveNextSeqOverride('REGTEST', ' 0 ')).to.equal(0);
        });

        it('refuses a set override on testnet, mainnet and a standalone hub with a named error', function () {
            for (const network of ['testnet', 'mainnet', '']) {
                let error;
                try { resolveArchiveNextSeqOverride(network, '151'); } catch (e) { error = e; }
                expect(error, network).to.be.instanceOf(ArchiveNextSeqOverrideNetworkError);
                expect(error.name).to.equal('ArchiveNextSeqOverrideNetworkError');
                expect(error.network).to.equal(network);
                expect(error.message).to.contain(NEXT_SEQ_OVERRIDE).and.to.contain(JSON.stringify(network));
            }
        });

        it('refuses a value that is not a whole number on regtest', function () {
            for (const raw of ['abc', '-1', '1.5', '1e3', '9007199254740993'])
                expect(() => resolveArchiveNextSeqOverride('regtest', raw), raw)
                    .to.throw(ArchiveNextSeqOverrideValueError);
        });
    });
}

function registerDrawTests() {
    describe('the archive seq draw', function () {
        it('returns the pinned seq on regtest without reading the rows or the floors', async function () {
            setOverride('151');
            const pub = mkPub('regtest');
            pub._observedConsumedBatchSeq = 400;
            expect(await pub.getNextBatchSeq()).to.equal(151);
            expect(await pub.getNextBatchSeq(152)).to.equal(151);
            expect(await pub.leaderBatchSeqAboveOwn(151)).to.equal(151);
            expect(pub.db.getNextAnchorBatchSeq.called).to.equal(false);
        });

        it('redraws above the own spent seq as before when the override is unset', async function () {
            setOverride(undefined);
            const pub = mkPub('regtest');
            pub.db.getNextAnchorBatchSeq.resolves([{ next_seq: 140 }]);
            expect(await pub.leaderBatchSeqAboveOwn(await pub.getNextBatchSeq())).to.equal(152);
            expect(pub.db.getNextAnchorBatchSeq.called).to.equal(true);
        });

        it('refuses the draw on testnet and mainnet with ArchiveNextSeqOverrideNetworkError', async function () {
            setOverride('151');
            for (const network of ['testnet', 'mainnet']) {
                const pub = mkPub(network);
                let error;
                try { await pub.getNextBatchSeq(); } catch (e) { error = e; }
                expect(error, network).to.be.instanceOf(ArchiveNextSeqOverrideNetworkError);
                expect(error.network).to.equal(network);
                expect(pub.db.getNextAnchorBatchSeq.called).to.equal(false);
            }
        });
    });
}

function registerBootTests() {
    describe('the boot refusal', function () {
        let exits, errors, originalExit;
        const logger = { error: (line) => errors.push(line) };

        beforeEach(function () {
            exits = [];
            errors = [];
            originalExit = process.exit;
            process.exit = (code) => { exits.push(code); };
        });

        afterEach(function () {
            process.exit = originalExit;
        });

        it('stops a testnet or mainnet hub that sets the override, naming the error', function () {
            setOverride('151');
            for (const network of ['testnet', 'mainnet']) {
                exits = [];
                errors = [];
                refuseArchiveSeqOverride({ logger, HUB_NETWORK: network });
                expect(exits, network).to.deep.equal([1]);
                expect(errors[0]).to.match(/^ArchiveNextSeqOverrideNetworkError: /).and.to.contain(network);
            }
        });

        it('runs as part of the boot network check', function () {
            setOverride('151');
            refuseInvalidNetwork({ logger, hubConfig: {}, P2P_VALIDATOR_ADDR: '', HUB_NETWORK: 'testnet' });
            expect(exits).to.deep.equal([1]);
            expect(errors[0]).to.match(/^ArchiveNextSeqOverrideNetworkError: /);
        });

        it('lets a regtest hub with the override, and any hub without it, start', function () {
            setOverride('151');
            refuseArchiveSeqOverride({ logger, HUB_NETWORK: 'regtest' });
            setOverride(undefined);
            for (const network of ['testnet', 'mainnet', ''])
                refuseArchiveSeqOverride({ logger, HUB_NETWORK: network });
            expect(exits).to.deep.equal([]);
            expect(errors).to.deep.equal([]);
        });
    });
}

describe('StateAnchorPublisher: regtest-only next archive seq override', function () {
    beforeEach(function () {
        savedEnv = process.env[NEXT_SEQ_OVERRIDE];
    });

    afterEach(function () {
        setOverride(savedEnv);
    });

    registerResolverTests();
    registerDrawTests();
    registerBootTests();
});
