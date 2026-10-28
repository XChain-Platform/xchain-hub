'use strict';

const {
    sinon,
    expect,
    waitUntil,
    bufferedFixture,
    makeDb,
    makePublisher,
    cleanupPublisherBatch
} = require('../oracle_publisher_batch.test.js');

// A reorg retracts a published PRICE batch, and the new branch re-mines the same
// window. When the retraction reaches the hub AFTER the new branch already carries
// the batch (a delayed or retried delivery), the D28 recovery must not put a second
// wire on chain for a window the active chain already shows. When the chain does
// NOT carry it, or cannot be asked, the recovery re-publish must still go out once.

const WINDOW = [0, 1, 2, 3, 4, 5];

// The hub's own v0 price_snapshots rows for the rounds a retraction restores.
function v0Rows(rounds) {
    let rows = [];
    for (let r of rounds) {
        let b = bufferedFixture(r);
        for (let p of b.pairs) {
            rows.push({ round_number: r, coin_pair: p.pair, price: p.price, reference_block: b.btcBlockHeight,
                        block_timestamp: b.timestamp, admit_block_btc: null, admit_block_ltc: null,
                        admit_block_doge: null });
        }
    }
    return rows;
}

// Window 0 published once, then its batch landed (the push sheds the buffer), which
// is the state a later retraction finds. `answers` is what the landing chain's
// indexer reports on each successive getpricebatches call; a string rejects.
async function publishedAndLanded(answers, cfg) {
    let db = makeDb();
    db.findV0PriceSnapshotsForRounds = async (rounds) => v0Rows(rounds);
    let h = makePublisher({ db: db, cfg: cfg || { ORACLE_BATCH_GRACE_MS: 60000 } });
    await h.p.start();
    for (let r of WINDOW) h.p._buffer.set(r, bufferedFixture(r));
    await h.p.assembleWindow(0);
    expect(h.broadcasts).to.have.length(1);
    expect(Object.keys(db.markers)).to.have.length(6);
    h.p.noteBatchLanded(0, 5, { sourceChain: 'DOGE', actionIndex: 6997 });
    expect(h.p._buffer.size).to.equal(0);

    h.hub.resolveIndexerUrl = sinon.stub().resolves('http://doge-indexer:3114');
    let rpc = sinon.stub(h.p, 'indexerRpc');
    answers.forEach((a, i) => {
        if (typeof a === 'string') rpc.onCall(i).rejects(new Error(a));
        else rpc.onCall(i).resolves({ batches: a, truncated: false });
    });
    let last = answers[answers.length - 1];
    if (typeof last === 'string') rpc.rejects(new Error(last));
    else rpc.resolves({ batches: last, truncated: false });
    return { h, db, rpc };
}

const relandedBeforeTheRetraction = async function () {
    let { h, db, rpc } = await publishedAndLanded([[{ first_round: 0, last_round: 5 }]], { ORACLE_BATCH_GRACE_MS: 1 });

    expect(await h.p.clearPublishedMarkers(WINDOW)).to.equal(0);

    expect(rpc.called, 'the chain was asked').to.equal(true);
    expect(Object.keys(db.markers), 'the durable markers stand').to.have.length(6);
    expect(h.p._assembledWindows.has(0), 'the window memo stands').to.equal(true);
    expect(h.p._buffer.size, 'nothing restored to propose').to.equal(0);
    expect(h.p._windows.has(0), 'the window is not re-armed').to.equal(false);

    await new Promise(resolve => setTimeout(resolve, 20));
    await h.p._windowChain;
    await h.p.assembleWindow(0);
    expect(h.signer.calls, 'no second signing round').to.have.length(1);
    expect(h.broadcasts, 'no duplicate wire').to.have.length(1);
};

const relandedBetweenClearAndAssembly = async function () {
    // The clear finds nothing on chain yet; by the time the window assembles the new
    // branch carries it.
    let { h, db } = await publishedAndLanded([[], [{ first_round: 0, last_round: 5 }]]);

    expect(await h.p.clearPublishedMarkers(WINDOW)).to.equal(6);
    expect(Object.keys(db.markers)).to.have.length(0);
    expect(h.p._buffer.size).to.equal(6);

    await h.p.assembleWindow(0);
    expect(h.signer.calls, 'no second signing round').to.have.length(1);
    expect(h.broadcasts, 'no duplicate wire').to.have.length(1);
    expect(h.p._buffer.size).to.equal(0);
    expect(h.p._assembledWindows.has(0)).to.equal(true);
    expect(h.p._windows.has(0), 'the restore grace timer is disarmed').to.equal(false);
};

const notCarriedRepublishesOnce = async function () {
    let { h, db } = await publishedAndLanded([[]], { ORACLE_BATCH_GRACE_MS: 1 });

    expect(await h.p.clearPublishedMarkers(WINDOW)).to.equal(6);
    expect(Object.keys(db.markers)).to.have.length(0);
    await waitUntil(() => h.broadcasts.length === 2);
    await h.p._windowChain;
    await h.p.assembleWindow(0);
    expect(h.broadcasts, 'the D28 recovery re-publish goes out exactly once').to.have.length(2);
    expect(h.signer.calls[1].rounds).to.deep.equal(WINDOW);
};

const partlyCarriedRepublishesTheRest = async function () {
    let { h, db } = await publishedAndLanded([[{ first_round: 0, last_round: 2 }]]);

    expect(await h.p.clearPublishedMarkers(WINDOW)).to.equal(3);
    expect(Object.keys(db.markers).map(Number).sort()).to.deep.equal([0, 1, 2]);
    await h.p.assembleWindow(0);
    expect(h.broadcasts).to.have.length(2);
    expect(h.signer.calls[1].rounds, 'only the rounds the chain lacks').to.deep.equal([3, 4, 5]);
};

const unreachableIndexerFailsOpen = async function () {
    let { h, db } = await publishedAndLanded(['connect ECONNREFUSED']);

    expect(await h.p.clearPublishedMarkers(WINDOW)).to.equal(6);
    expect(Object.keys(db.markers)).to.have.length(0);
    await h.p.assembleWindow(0);
    expect(h.broadcasts, 'a duplicate costs a fee; a lost recovery costs the window').to.have.length(2);
    expect(h.p.getStats().chainReconcileFailures).to.be.at.least(1);
};

function registerSuite() {
    it('keeps the markers and publishes nothing when the new branch already carries the window', relandedBeforeTheRetraction);
    it('sheds the restored window at assembly when the new branch re-lands it after the clear', relandedBetweenClearAndAssembly);
    it('still re-publishes exactly once when the chain does not carry the window', notCarriedRepublishesOnce);
    it('re-publishes only the rounds the new branch does not carry', partlyCarriedRepublishesTheRest);
    it('fails open to the recovery re-publish when the indexer cannot be asked', unreachableIndexerFailsOpen);
}

function registerOuter() {
    beforeEach(function () {
        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
        sinon.stub(console, 'error');
    });
    afterEach(function () {
        cleanupPublisherBatch();
    });
    describe('no re-publish of a retracted window the new branch already carries', registerSuite);
}

describe('OraclePublisher PRICE batch rail', registerOuter);
