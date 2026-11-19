'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -


const { expect }   = require('chai');
const { makeHub, describeOraclePublisher } = require('./helpers/oracle_publisher_harness');


let fsMock;
let OraclePublisher;

// Bind this file's fsMock and OraclePublisher to the module each test loads.
function oraclePublisherTests(title, registerTests) {
    describeOraclePublisher(title, (loaded) => { ({ fsMock, OraclePublisher } = loaded); }, registerTests);
}


// ── readQueue ────────────────────────────────────────────────────────────

oraclePublisherTests('readQueue()', function () {
    it('returns empty array when queue file does not exist', function () {
        fsMock.readFileSync.throws(new Error('ENOENT'));
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        expect(pub.readQueue()).to.deep.equal([]);
    });

    it('parses valid JSONL entries', function () {
        let e1 = { round: 1, prices: [] };
        let e2 = { round: 2, prices: [] };
        fsMock.readFileSync.returns(JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n');
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        let entries = pub.readQueue();
        expect(entries).to.have.length(2);
        expect(entries[0].round).to.equal(1);
    });

    it('skips invalid JSON lines', function () {
        fsMock.readFileSync.returns('INVALID_JSON\n' + JSON.stringify({ round: 1 }) + '\n');
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        let entries = pub.readQueue();
        expect(entries).to.have.length(1);
    });

    it('skips blank lines', function () {
        fsMock.readFileSync.returns('\n\n' + JSON.stringify({ round: 1 }) + '\n\n');
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        let entries = pub.readQueue();
        expect(entries).to.have.length(1);
    });

});


// ── rewriteQueue ─────────────────────────────────────────────────────────

oraclePublisherTests('rewriteQueue()', function () {
    it('writes JSON lines for each entry', function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        let entries = [{ round: 1 }, { round: 2 }];
        pub.rewriteQueue(entries);
        expect(fsMock.writeSync.called).to.be.true;
        let written = fsMock.writeSync.firstCall.args[1];
        expect(written).to.include('{"round":1}');
        expect(written).to.include('{"round":2}');
    });

    it('writes empty string for empty entries', function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        pub.rewriteQueue([]);
        let written = fsMock.writeSync.firstCall.args[1];
        expect(written).to.equal('');
    });

    it('handles fs error gracefully without throwing', function () {
        fsMock.openSync.throws(new Error('disk full'));
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        pub.rewriteQueue([{ round: 1 }]); // must not throw
    });

    // Never open the live queue with 'w': write a sibling temp file and rename it over.
    it('writes a temp file and renames it over the queue, never truncating the queue itself', function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        expect(pub.rewriteQueue([{ round: 1 }])).to.equal(true);
        let opened = fsMock.openSync.getCalls().filter(c => c.args[1] === 'w').map(c => c.args[0]);
        expect(opened).to.deep.equal([pub.queuePath + '.tmp'], 'only the temp file is opened for writing');
        expect(fsMock.renameSync.calledOnceWithExactly(pub.queuePath + '.tmp', pub.queuePath)).to.equal(true);
        expect(fsMock.renameSync.calledAfter(fsMock.fsyncSync), 'the rename follows the fsync').to.equal(true);
    });

    it('never renames over the queue when the write fails, and reports the failure', function () {
        fsMock.writeSync.throws(new Error('ENOSPC: no space left on device'));
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        expect(pub.rewriteQueue([{ round: 1 }])).to.equal(false);
        expect(fsMock.renameSync.called, 'a failed write leaves the old queue in place').to.equal(false);
        expect(fsMock.unlinkSync.calledWith(pub.queuePath + '.tmp'), 'the temp file is cleaned up').to.equal(true);
    });

});


// ── the rebuild persists only what it read ───────────────────────────────

const ioError = (code) => Object.assign(new Error(code + ': injected'), { code });
const lastWrite = () => fsMock.writeSync.getCall(fsMock.writeSync.callCount - 1).args[1];

oraclePublisherTests('readQueueState()', function () {
    it('reads a missing queue as empty and any other read failure as null', function () {
        let pub = new OraclePublisher(makeHub());
        fsMock.readFileSync.throws(ioError('ENOENT'));
        expect(pub.readQueueState()).to.deep.equal({ entries: [], rejected: [] });
        fsMock.readFileSync.throws(ioError('EIO'));
        expect(pub.readQueueState()).to.equal(null);
        expect(pub.readQueue()).to.deep.equal([]);
    });
});

oraclePublisherTests('getStats() queueDepth over an unreadable queue', function () {
    it('reports null for a read failure so the monitor can tell it from an empty queue', function () {
        let pub = new OraclePublisher(makeHub());
        fsMock.readFileSync.throws(ioError('EIO'));
        expect(pub.getStats().queueDepth).to.equal(null);
        fsMock.readFileSync.throws(ioError('EACCES'));
        expect(pub.getStats().queueDepth).to.equal(null);
    });

    it('reports 0 for a missing queue file and the entry count for a readable one', function () {
        let pub = new OraclePublisher(makeHub());
        fsMock.readFileSync.throws(ioError('ENOENT'));
        expect(pub.getStats().queueDepth).to.equal(0);
        fsMock.readFileSync.returns(JSON.stringify({ round: 1 }) + '\n' + JSON.stringify({ round: 2 }) + '\n');
        expect(pub.getStats().queueDepth).to.equal(2);
    });
});

oraclePublisherTests('rebuildQueueAfterPass() over an unreadable or corrupt queue', function () {
    it('skips the rewrite and keeps the dedup guard armed when the fresh read fails', function () {
        let pub = new OraclePublisher(makeHub());
        pub._publishedRounds.mark(1);
        fsMock.readFileSync.throws(ioError('EIO'));
        pub.rebuildQueueAfterPass([{ round: 1 }, { round: 2 }], [{ round: 2 }]);
        expect(fsMock.renameSync.called, 'the queue file is never replaced').to.equal(false);
        expect(fsMock.writeSync.called).to.equal(false);
        expect(pub._publishedRounds.has(1)).to.equal(true);
    });

    it('moves an unparseable line to the dead-letter file before the rewrite drops it', function () {
        let pub = new OraclePublisher(makeHub());
        fsMock.readFileSync.returns('GARBAGE{"round":3\n' + JSON.stringify({ round: 2 }) + '\n');
        pub.rebuildQueueAfterPass([{ round: 1 }], []);
        let deadLetter = fsMock.openSync.getCalls().filter(c => c.args[0] === pub.deadLetterPath);
        expect(deadLetter).to.have.length(1);
        let record = JSON.parse(fsMock.writeSync.firstCall.args[1]);
        expect(record.raw).to.equal('GARBAGE{"round":3');
        expect(pub.getStats().corruptQueueLines).to.equal(1);
        expect(lastWrite()).to.equal(JSON.stringify({ round: 2 }) + '\n');
    });

    it('keeps an unparseable line verbatim on the queue when the dead-letter write fails', function () {
        let pub = new OraclePublisher(makeHub());
        fsMock.readFileSync.returns('GARBAGE\n' + JSON.stringify({ round: 2 }) + '\n');
        fsMock.openSync.callsFake((file) => { if (file === pub.deadLetterPath) throw ioError('EACCES'); return 99; });
        pub.rebuildQueueAfterPass([{ round: 1 }], []);
        expect(lastWrite()).to.equal(JSON.stringify({ round: 2 }) + '\nGARBAGE\n');
        expect(pub.corruptQueueLines).to.equal(0);
    });
});

oraclePublisherTests('hydrateBuffer() over a corrupt round buffer file', function () {
    const round3 = JSON.stringify({ round: 3, timestamp: 30, btcBlockHeight: 300, pairs: [] });
    const deadLetterWrites = (pub) => fsMock.openSync.getCalls().filter(c => c.args[0] === pub.deadLetterPath);

    it('moves an unparseable line to the dead-letter file before the rewrite drops it', function () {
        let pub = new OraclePublisher(makeHub());
        fsMock.readFileSync.returns('GARBAGE{"round":2\n' + round3 + '\n');
        pub.hydrateBuffer();
        expect(deadLetterWrites(pub)).to.have.length(1);
        let record = JSON.parse(fsMock.writeSync.firstCall.args[1]);
        expect(record.raw).to.equal('GARBAGE{"round":2');
        expect(record.reason).to.equal('unparseable round buffer line');
        expect(pub.getStats().corruptBufferLines).to.equal(1);
        expect(Array.from(pub._buffer.keys())).to.deep.equal([3]);
        expect(lastWrite()).to.equal(round3 + '\n');
    });

    it('keeps an unparseable line verbatim in the buffer when the dead-letter write fails', function () {
        let pub = new OraclePublisher(makeHub());
        fsMock.readFileSync.returns('GARBAGE\n' + round3 + '\n');
        fsMock.openSync.callsFake((file) => { if (file === pub.deadLetterPath) throw ioError('EACCES'); return 99; });
        pub.hydrateBuffer();
        expect(lastWrite()).to.equal(round3 + '\nGARBAGE\n');
        pub.rewriteBufferFile(pub.bufferedRange(-Infinity, Infinity));
        expect(lastWrite(), 'a later compaction keeps it too').to.equal(round3 + '\nGARBAGE\n');
    });

    it('rewrites a file whose last line has no newline so the next append cannot glue onto it', function () {
        let pub = new OraclePublisher(makeHub());
        fsMock.readFileSync.returns(round3 + '\n{"round":4,"timest');
        pub.hydrateBuffer();
        expect(deadLetterWrites(pub)).to.have.length(1);
        expect(lastWrite()).to.equal(round3 + '\n');
    });

    it('leaves a clean file alone', function () {
        let pub = new OraclePublisher(makeHub());
        fsMock.readFileSync.returns(round3 + '\n');
        pub.hydrateBuffer();
        expect(fsMock.renameSync.called).to.equal(false);
        expect(deadLetterWrites(pub)).to.have.length(0);
        expect(pub.getStats().corruptBufferLines).to.equal(0);
    });
});

oraclePublisherTests('hydrateBuffer() over a buffer whose last round lacks its newline', function () {
    it('terminates the file even though every line parses', function () {
        let pub = new OraclePublisher(makeHub());
        let round5 = JSON.stringify({ round: 5, timestamp: 50, btcBlockHeight: 500, pairs: [] });
        fsMock.readFileSync.returns(round5);
        pub.hydrateBuffer();
        expect(pub.getStats().corruptBufferLines).to.equal(0);
        expect(lastWrite()).to.equal(round5 + '\n');
    });
});
