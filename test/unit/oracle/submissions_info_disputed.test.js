'use strict';

const assert = require('node:assert/strict');
const oracleDb = require('../../../src/db/oracle');
const submissionsInfo = require('../../../src/oracle/round/submissions_info');

function roundWith(disputedRead) {
    return {
        submissions: new Map(),
        db: {
            findPriceSnapshotRoundsSkippedWithNoFinalized: async () => [],
            findPriceSnapshotsSkippedWithFinalizedRound: async () => [],
            getPriceSnapshotsDisputedRoundSummary: disputedRead
        }
    };
}

describe('getoraclesubmissions disputed round diagnostics', function () {
    it('reads a distinct durable count and latest disputed round', async function () {
        let issued;
        await oracleDb.getPriceSnapshotsDisputedRoundSummary.call({
            doQuery: async sql => {
                issued = sql;
                return [];
            }
        });

        assert.match(issued, /COUNT\(DISTINCT round_number\) AS disputed_count/i);
        assert.match(issued, /MAX\(round_number\) AS last_disputed_round/i);
        assert.match(issued, /WHERE status = 'disputed'/i);
    });

    it('exports database numerics as JSON numbers', async function () {
        let round = roundWith(async () => [{
            disputed_count: '4',
            last_disputed_round: '981'
        }]);

        let info = await submissionsInfo.getSubmissionsInfo.call(round);

        assert.equal(info.disputedRoundCount, 4);
        assert.equal(info.lastDisputedRound, 981);
        assert.equal(info.disputedRoundsReadError, false);
    });

    it('reports the clean empty-table state', async function () {
        let round = roundWith(async () => [{
            disputed_count: '0',
            last_disputed_round: null
        }]);

        let info = await submissionsInfo.getSubmissionsInfo.call(round);

        assert.equal(info.disputedRoundCount, 0);
        assert.equal(info.lastDisputedRound, null);
        assert.equal(info.disputedRoundsReadError, false);
    });

    it('marks a failed disputed read without failing the diagnostics RPC', async function () {
        let round = roundWith(async () => { throw new Error('read failed'); });

        let info = await submissionsInfo.getSubmissionsInfo.call(round);

        assert.equal(info.disputedRoundCount, 0);
        assert.equal(info.lastDisputedRound, null);
        assert.equal(info.disputedRoundsReadError, true);
    });
});
