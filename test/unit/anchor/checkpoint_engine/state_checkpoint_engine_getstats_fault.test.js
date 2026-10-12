'use strict';

const { expect } = require('chai');
const stats = require('../../../../src/anchor/checkpoint_engine/stats');

function mkEngine(db) {
    return Object.assign({ db, network: 'regtest' }, stats, {
        _roundTimeouts: 0, _malformedFinalized: 0, _subQuorumFinalized: 0, _seqConflicts: 0,
        _seqDoubleSignRefusals: 0, _observerIdle: false, _cadenceStalls: 0,
        _cadenceStallReason: null, _cadenceStallBlock: null,
        _notMySlotTicks: 0, _notMySlotBlock: null, _frozenTipTicks: 0
    });
}

describe('StateCheckpointEngine getStats DB read fault', () => {
    it('rejects instead of reporting an empty last_finalized_by_chain', async () => {
        const db = { async findStateCheckpointsByNetwork() { throw new Error('db down'); } };
        let err = null;
        let out = null;
        try { out = await mkEngine(db).getStats(); } catch (e) { err = e; }
        expect(out).to.equal(null);
        expect(err).to.be.an('error');
        expect(err.message).to.equal('db down');
    });

    it('reports finalized heights when the read succeeds', async () => {
        const db = { async findStateCheckpointsByNetwork(n) {
            expect(n).to.equal('regtest');
            return [{ chain: 'BTC', last_finalized_block: '494', last_seq: '7' }];
        } };
        const out = await mkEngine(db).getStats();
        expect(out.last_finalized_by_chain).to.deep.equal({ BTC: { block_index: 494, checkpoint_seq: 7 } });
    });
});
