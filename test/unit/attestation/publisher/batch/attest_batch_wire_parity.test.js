/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/attestBatchWireParity.test.js
 *
 * The ATTEST v5/v6 batch wire is written ONCE and vendored twice: the hub BUILDS
 * the wire (src/lib/attest_batch_wire.js) and the indexer PARSES it
 * (xchain-indexer/src/actions/attest/attest_batch_wire.js). Two hand-written layouts of one wire
 * is the failure parallel building invites, so the two copies are byte twins and
 * this file is the hub-side half of the guard, on the pattern the ATTEST relay
 * flag-day twin already uses.
 *
 * Byte-identity, not value-identity: neither copy carries a per-file self
 * reference (the module header names BOTH paths precisely so this comparison can
 * admit no exceptions), so comment drift is drift too.
 *
 * The wire is an entry plus a parts directory (attest_batch_wire/ beside the entry
 * in both repos), and a part is as much the wire as the entry is, so every part is
 * compared byte for byte and the two part SETS are compared as a whole.
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const fs   = require('fs');
const path = require('path');

const local = require('../../../../../src/lib/attest_batch_wire.js');
const { isAdmissionEra } = require('../../../../../src/consensus/gates/mirror_admission_gate.js');

// Sibling checkout, resolved the way every other twin test resolves it: an explicit
// env path for CI (actions/checkout cannot write above the workspace), falling back
// to the dev sibling layout. Absent means skip, unless CI demands the comparison.
const INDEXER_DIR = process.env.XCHAIN_INDEXER_DIR ||
    path.join(__dirname, '..', '..', '..', '..', '..', '..', 'xchain-indexer');
const TWIN_PATH  = path.join(INDEXER_DIR, 'src', 'actions', 'attest', 'attest_batch_wire.js');
const LOCAL_PATH = path.join(__dirname, '..', '..', '..', '..', '..', 'src', 'lib', 'attest_batch_wire.js');
const TWIN_PARTS  = path.join(INDEXER_DIR, 'src', 'actions', 'attest', 'attest_batch_wire');
const LOCAL_PARTS = path.join(__dirname, '..', '..', '..', '..', '..', 'src', 'lib', 'attest_batch_wire');

// The part count when the split landed. It only ever rises, so a new part needs no
// edit here, while an emptied, renamed or unreadable parts directory compares
// nothing and fails instead of reading green.
const PARTS_FLOOR = 4;

// Every .js file under one parts directory, sorted, relative to it. A read error
// yields an empty list on purpose, which the floor turns into a failure.
function listParts(dir){
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return []; }
    return names.filter((n) => n.endsWith('.js')).sort();
}

// The whole parts directory: at or above the floor, the same part SET on both sides (a
// part on one side only is wire code one service runs and the other cannot), and every
// part byte for byte, each failure naming the part. It runs inside the entry's
// byte-identity case rather than as one case per part, because the hub's suite-title
// pin freezes this suite's titles.
function expectPartsIdentical(){
    const parts = listParts(LOCAL_PARTS);
    expect(parts.length, 'expected at least ' + PARTS_FLOOR + ' parts under src/lib/attest_batch_wire/')
        .to.be.at.least(PARTS_FLOOR);
    expect(parts).to.deep.equal(listParts(TWIN_PARTS),
        'the hub and indexer disagree about which attest_batch_wire parts exist; a part on one ' +
        'side only is wire code one service runs and the other cannot');
    for (const part of parts) {
        expect(fs.readFileSync(path.join(LOCAL_PARTS, part), 'utf8'))
            .to.equal(fs.readFileSync(path.join(TWIN_PARTS, part), 'utf8'),
                'attest_batch_wire/' + part + ' has drifted from the indexer twin; re-vendor every part');
    }
}

// A window built to exercise everything the canonical normalizes: a null field, a
// number and a string spelling of the same integer column, and rows in an order the
// codec must preserve rather than re-sort.
function window(){
    return {
        network: 'regtest', window_start: 1780000000, window_end: 1780003600,
        row_count: 2, btc_block_height: 941234,
        rows: [
            { network: 'regtest', request_id: 'ab'.repeat(32), request_action_index: 4400,
              request_block_index: 120, provider_id: 'http_get', status: 'ok',
              response_payload: '{"ok":true}', response_hash: 'cd'.repeat(32), meta: '200',
              effective_time: 1780000120, signer_pubkeys: '["' + 'aa'.repeat(32) + '"]',
              signatures: '[{"pubkey":"' + 'aa'.repeat(32) + '","sig":"' + 'ee'.repeat(64) + '"}]',
              widen: 0 },
            { network: 'regtest', request_id: 'cd'.repeat(32), request_action_index: null,
              request_block_index: '121', provider_id: 'llm', status: 'ok',
              response_payload: 'plain', response_hash: 'ef'.repeat(32), meta: '',
              effective_time: 1780000121, signer_pubkeys: '[]', signatures: '[]', widen: 2 }
        ],
        sigs: [{ pubkey: 'bb'.repeat(32), sig: 'cc'.repeat(64) }]
    };
}

describe('ATTEST v5/v6 batch wire: hub twin @regression', function () {

    describe('byte-identity with the xchain-indexer twin', function () {
        before(function () {
            if (!fs.existsSync(TWIN_PATH)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the indexer twin was not found at ' + TWIN_PATH);
                this.skip();
            }
        });

        it('is byte-identical to xchain-indexer/src/actions/attest/attest_batch_wire.js', function () {
            expect(fs.readFileSync(LOCAL_PATH, 'utf8'))
                .to.equal(fs.readFileSync(TWIN_PATH, 'utf8'),
                    'the hub copy has drifted from the indexer twin; the hub builds this wire and ' +
                    'the indexer parses it, so a one-sided edit publishes batches the fleet refuses');
            expectPartsIdentical();   // in this case, not one per part: the title pin holds the titles
        });

        it('produces identical wires and an identical canonical from identical input', function () {
            const twin = require(TWIN_PATH);
            expect(local.buildAttestBatchCanonical(window(), isAdmissionEra))
                .to.equal(twin.buildAttestBatchCanonical(window(), isAdmissionEra));
            const mine   = local.encodeAttestBatch(window(), isAdmissionEra);
            const theirs = twin.encodeAttestBatch(window(), isAdmissionEra);
            expect(mine.ok && theirs.ok).to.equal(true);
            expect(mine.wires).to.deep.equal(theirs.wires);
            expect(mine.batchKey).to.equal(theirs.batchKey);
        });
    });

    describe('the constants this hub publishes against', function () {
        it('pins the versions, the caps and the carried row fields', function () {
            expect(local.ATTEST_BATCH_HEAD_VERSION).to.equal(5);
            expect(local.ATTEST_BATCH_CONTINUATION_VERSION).to.equal(6);
            expect(local.ATTEST_BATCH_WIRE_MAX_BYTES).to.equal(8189);
            expect(local.ATTEST_BATCH_MAX_INFLATED_BYTES).to.equal(1048576);
            expect(local.ATTEST_BATCH_MAX_ROWS).to.equal(256);
            // The signed field set. `finalized_at` and `batch_action_index` must stay OFF
            // it: the first is hub wall clock two hubs may disagree on, and the second is
            // set by the batch landing itself, so a batch cannot carry its own.
            expect(local.ATTEST_BATCH_ROW_FIELDS).to.not.include('finalized_at');
            expect(local.ATTEST_BATCH_ROW_FIELDS).to.not.include('batch_action_index');
            expect(local.ATTEST_BATCH_ROW_FIELDS).to.not.include('id');
        });

        it('round-trips a window the hub built back through the parser', function () {
            const encoded = local.encodeAttestBatch(window(), isAdmissionEra);
            expect(encoded.ok).to.equal(true);
            const params = encoded.wires[0].split('|').slice(1);
            const head   = local.parseAttestBatchHead(params);
            expect(head.ok, head.status).to.equal(true);
            const back = local.reassembleAttestBatch(head, [], isAdmissionEra);
            expect(back.ok, back.status).to.equal(true);
            expect(back.batch.rows.length).to.equal(2);
            expect(local.buildAttestBatchCanonical(back.batch, isAdmissionEra))
                .to.equal(local.buildAttestBatchCanonical(window(), isAdmissionEra));
        });
    });
});
