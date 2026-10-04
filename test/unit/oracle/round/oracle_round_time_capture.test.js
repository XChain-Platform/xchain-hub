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
const { makeRoundTimeCapture } = require('./helpers/round_time_capture');

const ROUND  = 81;
const HEIGHT = 900000;
const TIME   = 1700000000;

describe('OracleRound round-time capture harness', function () {
    let capture;

    afterEach(function () {
        if (capture) capture.restore();
        capture = null;
    });

    it('captures a real anchor finalization with its block time', async function () {
        capture = makeRoundTimeCapture({
            network: 'mainnet', quorum: 2, height: HEIGHT, blockTime: TIME, fallbackActive: false
        });

        expect(await capture.finalize(ROUND)).to.deep.equal({
            kind: 'finalized', args: [ROUND, HEIGHT, TIME]
        });
    });

    it('captures a federated round-number anchor skip with its block time', async function () {
        capture = makeRoundTimeCapture({
            network: 'mainnet', quorum: 2, height: ROUND, blockTime: TIME, fallbackActive: true
        });

        expect(await capture.finalize(ROUND)).to.deep.equal({
            kind: 'skipped',
            args: [ROUND, ROUND, TIME, 'round-number anchor on a federated hub']
        });
    });

    it('captures every in-flight round skipped at stop with the current block time', async function () {
        capture = makeRoundTimeCapture({
            network: 'mainnet', quorum: 2, height: HEIGHT, blockTime: TIME, fallbackActive: false
        });

        expect(await capture.stopInFlight([ROUND, ROUND + 1])).to.deep.equal([
            [ROUND, HEIGHT, TIME, 'hub stopped before finalization'],
            [ROUND + 1, HEIGHT, TIME, 'hub stopped before finalization']
        ]);
    });
});
