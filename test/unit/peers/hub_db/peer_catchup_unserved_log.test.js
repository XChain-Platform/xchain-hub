'use strict';
const sinon = require('sinon');
const { expect } = require('chai');
const { PEER, PEER_B, peerManager, makeCatchup } = require('./helpers/peer_catchup_harness.js');

const TABLES = ['price_snapshots', 'capability_snapshots', 'slash_proposals'];

function unauthorized() {
    const err = new Error('Snapshot request returned HTTP 401');
    err.statusCode = 401;
    return err;
}

function unservedLines(logger) {
    return logger.warn.getCalls().map(call => String(call.args[0])).filter(line => /unserved|no peer served/i.test(line));
}

describe('hub DB peer catch-up: unserved tables are named', function () {
    let clock;
    beforeEach(function () { clock = sinon.useFakeTimers({ now: 1e9, toFake: ['Date'] }); });
    afterEach(function () { clock.restore(); });

    function build() {
        const logger = { warn: sinon.stub(), error: sinon.stub() };
        const fetchPage = sinon.stub().rejects(unauthorized());
        const catchup = makeCatchup({
            tables: TABLES, peerManager: peerManager(true, { peers: 2 }), fetchPage, logger
        });
        return { catchup, fetchPage, logger };
    }

    it('names every unserved table and both peers, rate limited, state unchanged', async function () {
        const { catchup, fetchPage, logger } = build();
        await catchup.run();
        const first = unservedLines(logger);
        expect(first).to.have.length(1);
        for (const name of [...TABLES, PEER, PEER_B]) expect(first[0]).to.contain(name);
        const callsAfterFirst = fetchPage.callCount;

        // Peers are backed off now: no fetch, table state held, and no repeat line inside the interval.
        clock.tick(1000);
        await catchup.run();
        expect(fetchPage.callCount).to.equal(callsAfterFirst);
        expect(unservedLines(logger)).to.have.length(1);
        for (const table of TABLES) expect(catchup.tableCaughtUp(table)).to.equal(false);

        clock.tick(61000);
        await catchup.run();
        const after = unservedLines(logger);
        expect(after).to.have.length(2);
        for (const name of TABLES) expect(after[1]).to.contain(name);
    });
});
