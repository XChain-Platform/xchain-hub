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

// A stub engine over the given per-chain indexer answers; an Error answer is thrown.
function replayEngine(answers) {
    const calls = [];
    return {
        calls,
        _ticking: false,
        _cadenceStalls: 0,
        _cadenceStallReason: null,
        _cadenceStallBlock: null,
        _cadenceStallLoggedAt: 0,
        _cadenceStallLogMs: 60 * 60 * 1000,
        chains: Object.keys(answers),
        indexers: Object.fromEntries(Object.keys(answers).map((c) => [c, { url: 'http://stub/' + c }])),
        observerHold() { return false; },
        async retryFailedSelfAccepts() {},
        async indexerCall(chain) {
            calls.push(chain);
            if (answers[chain] instanceof Error) throw answers[chain];
            return answers[chain];
        },
        async resolveSnapshotBlock() {
            calls.push('snapshot block');
            return null;
        },
        leaderReplayHeld: cadence.leaderReplayHeld,
        noteCadenceStall: cadence.noteCadenceStall,
    };
}

async function withWarnings(fn) {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
        return { result: await fn(), warnings };
    } finally {
        console.warn = originalWarn;
    }
}

describe('checkpoint leader replay hold on an unreadable indexer', function () {
    it('holds the cadence when every chain\'s replay state is unreadable', async function () {
        const engine = replayEngine({ BTC: new Error('ETIMEDOUT') });
        const { warnings } = await withWarnings(() => cadence.tick.call(engine));

        expect(engine.calls).to.deep.equal(['BTC']);
        expect(engine._cadenceStalls).to.equal(1);
        expect(engine._cadenceStallReason).to.match(/^indexer_replay_unreadable: BTC: ETIMEDOUT/);
        expect(warnings.some((line) => line.includes('replay state unreadable for BTC'))).to.equal(true);
    });

    it('logs an unreadable chain and leaves it to its own round when another chain answered', async function () {
        const engine = replayEngine({ BTC: { rules: { replay: { state: 'idle' } } }, DOGE: new Error('HTTP 502') });
        const { result, warnings } = await withWarnings(() => engine.leaderReplayHeld(100));

        expect(result).to.equal(false);
        expect(engine._cadenceStalls).to.equal(0);
        expect(warnings.some((line) => line.includes('replay state unreadable for DOGE') && line.includes('HTTP 502')))
            .to.equal(true);
    });

    it('still holds with indexer_replaying when a readable chain replays beside an unreadable one', async function () {
        const engine = replayEngine({ DOGE: new Error('HTTP 502'), BTC: { rules: { replay: { state: 'replaying' } } } });
        const { result } = await withWarnings(() => engine.leaderReplayHeld(100));

        expect(result).to.equal(true);
        expect(engine).to.include({ _cadenceStalls: 1, _cadenceStallReason: 'indexer_replaying', _cadenceStallBlock: 100 });
    });
});
