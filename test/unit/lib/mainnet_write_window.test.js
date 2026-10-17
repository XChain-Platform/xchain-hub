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
const { mainnetWritesOpen, MAINNET_WRITES_OPEN_AT } = require('../../../src/lib/mainnet_write_window');
const lifecycle = require('../../../src/anchor/publisher/lifecycle');

describe('mainnetWritesOpen', function () {
    it('is closed on mainnet before the open time', function () {
        expect(MAINNET_WRITES_OPEN_AT).to.equal(1796083200);
        expect(mainnetWritesOpen('mainnet', 0)).to.equal(false);
        expect(mainnetWritesOpen('mainnet', 1796083199)).to.equal(false);
    });

    it('opens on mainnet at and after the open time', function () {
        expect(mainnetWritesOpen('mainnet', 1796083200)).to.equal(true);
        expect(mainnetWritesOpen('mainnet', 1796083201)).to.equal(true);
    });

    it('never gates other networks', function () {
        expect(mainnetWritesOpen('testnet', 0)).to.equal(true);
        expect(mainnetWritesOpen('regtest', 0)).to.equal(true);
    });

    it('fails closed on mainnet for an unusable clock', function () {
        for (const bad of [NaN, undefined, null, '1796083200', Infinity])
            expect(mainnetWritesOpen('mainnet', bad)).to.equal(false);
    });
});

describe('publisher flush window gate', function () {
    function fakePublisher(network) {
        return Object.assign({}, lifecycle, {
            network, _flushing: false, _leaderRetryDue: false,
            drainDeferredAnnouncements: async () => {},
            hub: {},
            resolveSigner: () => { throw new Error('must not be reached'); }
        });
    }

    it('skips the cycle on mainnet while the window is closed', async function () {
        const p = fakePublisher('mainnet');
        p.nowSeconds = () => 1796083199;
        const out = await p.flush();
        expect(out).to.deep.equal({ anchored: [], archive: 'none', skipped: 'mainnet_window_closed' });
        expect(p._flushing).to.equal(false);
    });

    it('does not skip on testnet', async function () {
        const p = fakePublisher('testnet');
        p.nowSeconds = () => 0;
        const out = await p.flush();
        expect(out.skipped).to.equal(undefined);
        expect(out.error).to.equal('must not be reached');
    });
});
