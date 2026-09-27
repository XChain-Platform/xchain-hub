'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../src/anchor/publisher');

function makePublisher(overrides){
    const calls = [];
    const consumed = [];
    const pub = {
        dogeAddress: 'Dpublisher',
        indexers: { DOGE: { url: 'http://doge-indexer' } },
        async indexerCall(coin, method, params){
            calls.push({ coin, method, params });
            return { exists: false };
        },
        noteConsumedBatchSeq(seq, why){ consumed.push({ seq, why }); }
    };
    Object.assign(pub, overrides || {});
    pub.seedArchiveSeqFloor = StateAnchorPublisher.prototype.seedArchiveSeqFloor;
    return { pub, calls, consumed };
}

async function captureWarnings(fn){
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try { await fn(); } finally { console.warn = original; }
    return warnings;
}

describe('StateAnchorPublisher: archive sequence floor seed', function () {

    it('runs once after indexer resolution and before startup timers', async function () {
        const order = [];
        const pub = {
            enabled: true,
            spendGuard: { persistTo(){ order.push('persist'); } },
            async resolveMissingIndexerUrls(){ order.push('resolve'); },
            async seedArchiveSeqFloor(){ order.push('seed'); },
            subscribeToAnchorSources(){ order.push('subscribe'); },
            startFlushTimers(){ order.push('timers'); },
            intervalMs: 1000,
            startupFlushMs: 0,
            batchSize: 10,
            dogeAddress: 'Dpublisher'
        };
        await StateAnchorPublisher.prototype.start.call(pub);
        expect(order).to.deep.equal(['persist', 'resolve', 'seed', 'subscribe', 'timers']);
    });

    it('seeds the consumed floor from the highest archive under this DOGE address', async function () {
        const rig = makePublisher({ indexerCall: async (coin, method, params) => {
            rig.calls.push({ coin, method, params });
            return { exists: true, match_batch_seq: 41 };
        } });
        await rig.pub.seedArchiveSeqFloor();
        expect(rig.calls).to.deep.equal([{
            coin: 'DOGE', method: 'getarchiveanchor', params: { author: 'Dpublisher' }
        }]);
        expect(rig.consumed).to.deep.equal([{
            seq: 41, why: 'boot-time floor seed from the DOGE indexer'
        }]);
    });

    it('leaves the floor untouched and warns when no prior archive exists', async function () {
        const rig = makePublisher();
        const warnings = await captureWarnings(() => rig.pub.seedArchiveSeqFloor());
        expect(rig.calls).to.have.length(1);
        expect(rig.consumed).to.deep.equal([]);
        expect(warnings.some(line => /found no archive/.test(line))).to.equal(true);
    });

    it('catches an indexer rejection and warns without throwing', async function () {
        const rig = makePublisher({ indexerCall: async () => { throw new Error('old indexer'); } });
        const warnings = await captureWarnings(() => rig.pub.seedArchiveSeqFloor());
        expect(rig.consumed).to.deep.equal([]);
        expect(warnings.some(line => /old indexer/.test(line))).to.equal(true);
    });

    it('does not call the indexer without a DOGE address or configured indexer', async function () {
        for(const missing of [
            { dogeAddress: '' },
            { indexers: {} },
            { indexers: { DOGE: { url: '' } } }
        ]){
            const rig = makePublisher(missing);
            await captureWarnings(() => rig.pub.seedArchiveSeqFloor());
            expect(rig.calls).to.deep.equal([]);
            expect(rig.consumed).to.deep.equal([]);
        }
    });
});
