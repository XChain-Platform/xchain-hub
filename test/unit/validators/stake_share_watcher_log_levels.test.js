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

const { makeVenue, makeWatcher } = require('../../helpers/stakeShareVenue.js');

describe('StakeShareWatcher log levels', function () {

    it('logs healthy startup messages at info and operational failures at error', async function () {
        const venue = makeVenue();
        const info = [];
        const errors = [];
        const logs = { infoLog: (line) => info.push(line), log: (line) => errors.push(line) };
        const { watcher } = makeWatcher(venue, null, null, Object.assign({
            chains: ['BTC', 'DOGE'],
            pollMs: 60000
        }, logs));
        watcher.pollOnce = async () => { throw new Error('unreachable indexer'); };

        expect(watcher.start()).to.equal(true);
        await Promise.resolve();
        watcher.stop();

        const { watcher: disabled } = makeWatcher(venue,
            { HUB_OPERATOR_STAKE_SOURCES: '' }, null, logs);
        expect(disabled.start()).to.equal(false);

        expect(info.some(line => line.includes('watches BTC only'))).to.equal(true);
        expect(info.some(line => line.includes('monitor watching BTC'))).to.equal(true);
        expect(errors.some(line => line.includes('monitor DISABLED'))).to.equal(true);
        expect(errors.some(line => line.includes('poll failed: unreachable indexer'))).to.equal(true);
        expect(errors.some(line => line.includes('watches BTC only') ||
            line.includes('monitor watching BTC'))).to.equal(false);
        expect(info.some(line => line.includes('monitor DISABLED') ||
            line.includes('poll failed: unreachable indexer'))).to.equal(false);
    });
});
