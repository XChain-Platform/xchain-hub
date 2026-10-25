/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Leader replay-hold cadence reason and ordering.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const cadence = require('../../../../src/anchor/checkpoint_engine/cadence.js');

describe('checkpoint supersede leader replay hold @regression', function () {
    it('logs indexer_replaying before an unavailable snapshot block can replace the reason', async function () {
        const calls = [];
        const warnings = [];
        const engine = {
            _ticking: false,
            _cadenceStalls: 0,
            _cadenceStallReason: null,
            _cadenceStallBlock: null,
            _cadenceStallLoggedAt: 0,
            _cadenceStallLogMs: 60 * 60 * 1000,
            chains: ['BTC'],
            indexers: { BTC: { url: 'http://stub' } },
            observerHold() { return false; },
            async retryFailedSelfAccepts() {},
            async indexerCall() {
                calls.push('replay hold');
                return { rules: { replay: { state: 'replaying' } } };
            },
            async resolveSnapshotBlock() {
                calls.push('snapshot block');
                return null;
            },
            leaderReplayHeld: cadence.leaderReplayHeld,
            noteCadenceStall: cadence.noteCadenceStall,
        };
        const originalWarn = console.warn;
        console.warn = (message) => warnings.push(String(message));
        try {
            await cadence.tick.call(engine);
        } finally {
            console.warn = originalWarn;
        }

        expect(calls).to.deep.equal(['replay hold']);
        expect(engine).to.include({
            _cadenceStalls: 1,
            _cadenceStallReason: 'indexer_replaying',
            _cadenceStallBlock: null,
            _ticking: false,
        });
        expect(warnings.some((line) => line.includes('indexer_replaying'))).to.equal(true);
        expect(warnings.some((line) => line.includes('no BTC snapshot block'))).to.equal(false);
    });
});
