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
