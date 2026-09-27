'use strict';

const { expect } = require('chai');
const { readArchiveSeqFloor } =
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
    const value = await readArchiveSeqFloor({
        indexerCall: fixture.indexerCall,
        dogeAddress: 'Dauthor',
        dogeIndexerUrl: 'http://indexer.invalid',
        logger: fixture.logger,
        ...overrides
    });
    return { ...fixture, value };
}

describe('archive sequence floor reader', () => {
    it('returns the author floor and makes the exact author-only call', async () => {
        const result = await read({ exists: true, match_batch_seq: 12 });

        expect(result.value).to.equal(12);
        expect(result.calls).to.deep.equal([
            ['DOGE', 'getarchiveanchor', { author: 'Dauthor' }]
        ]);
        expect(result.warnings).to.have.length(0);
    });

    it('returns null when no archive exists for the author', async () => {
        const result = await read({ exists: false, match_batch_seq: null });

        expect(result.value).to.equal(null);
        expect(result.calls).to.have.length(1);
    });

    it('returns null for a null response', async () => {
        const result = await read(null);

        expect(result.value).to.equal(null);
        expect(result.warnings).to.have.length(0);
    });

    for(const invalid of ['x', -1, 1.5, undefined]){
        it('returns null for invalid sequence ' + invalid, async () => {
            const result = await read({ exists: true, match_batch_seq: invalid });

            expect(result.value).to.equal(null);
            expect(result.warnings).to.have.length(0);
        });
    }

    it('warns once and returns null when the lookup rejects', async () => {
        const result = await read(new Error('unreachable'));

        expect(result.value).to.equal(null);
        expect(result.warnings).to.have.length(1);
        expect(result.warnings[0]).to.include('getarchiveanchor');
    });

    it('warns once and returns null when the lookup reports an error', async () => {
        const result = await read({ error: 'boom' });

        expect(result.value).to.equal(null);
        expect(result.warnings).to.have.length(1);
        expect(result.warnings[0]).to.include('getarchiveanchor');
    });

    it('does not call the indexer without a DOGE address', async () => {
        const result = await read({ exists: true, match_batch_seq: 12 }, { dogeAddress: '' });

        expect(result.value).to.equal(null);
        expect(result.calls).to.have.length(0);
    });

    it('does not call the indexer without a DOGE indexer URL', async () => {
        const result = await read({ exists: true, match_batch_seq: 12 }, { dogeIndexerUrl: null });

        expect(result.value).to.equal(null);
        expect(result.calls).to.have.length(0);
    });
});
