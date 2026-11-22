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
const { readArchiveSeqFloorOutcome } =
    require('../../../../../src/anchor/publisher/archive/seq_floor_seed.js');

function setup(reply){
    const calls = [];
    const warnings = [];
    const indexerCall = async (...args) => {
        calls.push(args);
        if(reply instanceof Error) throw reply;
        return reply;
    };
    const logger = { warn: message => warnings.push(message) };
    return { calls, warnings, indexerCall, logger };
}

async function read(reply, overrides = {}){
    const fixture = setup(reply);
    const outcome = await readArchiveSeqFloorOutcome({
        indexerCall: fixture.indexerCall,
        dogeAddress: 'Dauthor',
        dogeIndexerUrl: 'http://indexer.invalid',
        logger: fixture.logger,
        ...overrides
    });
    return { ...fixture, outcome };
}

describe('archive sequence floor reader', () => {
    it('returns the author floor and makes the exact author-only call', async () => {
        const result = await read({ exists: true, match_batch_seq: 12 });

        expect(result.outcome).to.deep.equal({ kind: 'ok', seq: 12 });
        expect(result.calls).to.deep.equal([
            ['DOGE', 'getarchiveanchor', { author: 'Dauthor' }]
        ]);
        expect(result.warnings).to.have.length(0);
    });

    it('returns null when no archive exists for the author', async () => {
        const result = await read({ exists: false, match_batch_seq: null });

        expect(result.outcome).to.deep.equal({ kind: 'none' });
        expect(result.calls).to.have.length(1);
    });

    it('returns null for a null response', async () => {
        const result = await read(null);

        expect(result.outcome).to.deep.include({ kind: 'unknown', reason: 'invalid_seq' });
        expect(result.warnings).to.have.length(0);
    });

    it('distinguishes a null response from an explicit author miss', async () => {
        expect((await read(null)).outcome).to.deep.include({ kind: 'unknown' });
        expect((await read({ exists: false, match_batch_seq: null })).outcome)
            .to.deep.equal({ kind: 'none' });
    });

    for(const invalid of ['x', -1, 1.5, undefined]){
        it('returns null for invalid sequence ' + invalid, async () => {
            const result = await read({ exists: true, match_batch_seq: invalid });

            expect(result.outcome).to.deep.include({ kind: 'unknown', reason: 'invalid_seq' });
            expect(result.warnings).to.have.length(0);
        });
    }
});

describe('archive sequence floor reader failures', () => {
    it('warns once and returns null when the lookup rejects', async () => {
        const result = await read(new Error('unreachable'));

        expect(result.outcome).to.deep.equal({
            kind: 'unknown', reason: 'lookup_failed', detail: 'unreachable'
        });
        expect(result.warnings).to.have.length(1);
        expect(result.warnings[0]).to.include('getarchiveanchor');
    });

    it('warns once and returns null when the lookup reports an error', async () => {
        const result = await read({ error: 'boom' });

        expect(result.outcome).to.deep.equal({
            kind: 'unknown', reason: 'indexer_error', detail: 'boom'
        });
        expect(result.warnings).to.have.length(1);
        expect(result.warnings[0]).to.include('getarchiveanchor');
    });

    it('does not call the indexer without a DOGE address', async () => {
        const result = await read({ exists: true, match_batch_seq: 12 }, { dogeAddress: '' });

        expect(result.outcome).to.deep.equal({ kind: 'unconfigured' });
        expect(result.calls).to.have.length(0);
    });

    it('does not call the indexer without a DOGE indexer URL', async () => {
        const result = await read({ exists: true, match_batch_seq: 12 }, { dogeIndexerUrl: null });

        expect(result.outcome).to.deep.equal({ kind: 'unconfigured' });
        expect(result.calls).to.have.length(0);
    });
});
