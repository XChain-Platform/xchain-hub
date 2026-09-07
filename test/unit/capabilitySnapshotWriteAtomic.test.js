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

// Six engines mirror a validator set into the shared capability_snapshots table, and every
// one of them wrote it one autocommit INSERT at a time. A fault on any single row left the
// earlier rows committed and the set for that (snapshot_block, capability) permanently
// PARTIAL, which downstream reads as COMPLETE and under-counts the stake denominator: the
// same accept/reject divergence each writer's truncation guard already fails closed to
// prevent by writing NOTHING.
//
// The CONTROL below drives the retired per-row shape through the same fake database and
// asserts it really does leave rows behind, so the all-or-nothing assertions that follow
// cannot be green merely because the harness never faulted mid-set.

const { expect }           = require('chai');
const fs                   = require('fs');
const path                 = require('path');
const snapWrite            = require('../../src/lib/capability_snapshot_write.js');
const StateCheckpointEngine = require('../../src/StateCheckpointEngine.js');

const BLOCK      = 953200;
const CAPABILITY = 'oracle_publish';
const VALIDATORS = [
    { pubkey: 'AA'.repeat(32), weight: '10', source: 'src-a' },
    { pubkey: 'bb'.repeat(32), weight: '20', source: 'src-b' },
    { pubkey: 'cc'.repeat(32), amount: '30', source: '' }
];

// Commits each INSERT statement it is given, except the `failAt`-th (1-based), which
// throws with nothing of that statement written. That is InnoDB's statement-level
// behaviour: a failed statement rolls back whole, and under autocommit the statement IS
// the transaction.
function memDb(failAt) {
    let rows  = [];
    let seen  = 0;
    return {
        rows: () => rows,
        statements: () => seen,
        async doQuery(sql, params) {
            if (!/^INSERT IGNORE INTO capability_snapshots/.test(sql)) return [];
            seen++;
            if (seen === failAt) throw new Error('lock wait timeout exceeded');
            for (let i = 0; i + 4 < params.length; i += 5) {
                let [snapshot_block, capability, signing_pubkey, amount, source] = params.slice(i, i + 5);
                rows.push({ snapshot_block, capability, signing_pubkey, amount, source });
            }
            return [];
        }
    };
}

describe('capability_snapshots mirror writes are all-or-nothing', function () {

    it('CONTROL: the retired per-row loop leaves a PARTIAL set behind a mid-set fault', async function () {
        let db = memDb(2);
        let threw = false;
        try {
            for (let v of VALIDATORS) {
                await db.doQuery(
                    'INSERT IGNORE INTO capability_snapshots (snapshot_block, capability, signing_pubkey, amount, source) VALUES (?, ?, ?, ?, ?)',
                    [BLOCK, CAPABILITY, String(v.pubkey).toLowerCase(),
                     String(v.weight != null ? v.weight : v.amount), String(v.source || '')]);
            }
        } catch (e) { threw = true; }
        expect(threw, 'the fault must reach the caller').to.equal(true);
        expect(db.rows().length,
            'the defect must reproduce here, or the all-or-nothing assertions prove nothing').to.equal(1);
    });

    it('writes the whole set in ONE statement', async function () {
        let db = memDb(0);
        let rows = await snapWrite.writeCapabilitySnapshotRows(db, CAPABILITY, BLOCK, VALIDATORS);
        expect(db.statements(), 'chunking would silently reintroduce the partial-commit window').to.equal(1);
        expect(db.rows().length).to.equal(3);
        expect(rows.length).to.equal(3);
    });

    it('leaves NOTHING behind when the write faults', async function () {
        let db = memDb(1);
        let threw = false;
        try { await snapWrite.writeCapabilitySnapshotRows(db, CAPABILITY, BLOCK, VALIDATORS); }
        catch (e) { threw = true; }
        expect(threw, 'the caller must still see the fault and fail closed').to.equal(true);
        expect(db.rows().length, 'no partial set may survive').to.equal(0);
    });

    it('normalizes exactly as the six in-loop copies did', function () {
        let rows = snapWrite.normalizeCapabilitySnapshotRows(CAPABILITY, BLOCK, VALIDATORS);
        expect(rows[0].signing_pubkey).to.equal('aa'.repeat(32));       // lowercased
        expect(rows[0].amount).to.equal('10');                          // weight preferred
        expect(rows[2].amount).to.equal('30');                          // amount when weight is absent
        expect(rows[2].source).to.equal('');                            // null source becomes ''
        expect(snapWrite.normalizeCapabilitySnapshotRows(CAPABILITY, BLOCK, [{ pubkey: 'dd'.repeat(32) }])[0].amount)
            .to.equal('0');
    });

    it('writes no statement at all for an empty set', async function () {
        let db = memDb(1);                                              // would throw if it ran
        expect(await snapWrite.writeCapabilitySnapshotRows(db, CAPABILITY, BLOCK, [])).to.deep.equal([]);
        expect(db.statements()).to.equal(0);
    });

    it('StateCheckpointEngine leaves no partial mirror when the snapshot write faults', async function () {
        let db  = memDb(1);
        let eng = new StateCheckpointEngine({ db, network: 'regtest', p2pConfig: {},
                                              getPeerManager: () => ({ on(){}, broadcast(){} }) });
        eng._resolveCapabilityValidators = async () => VALIDATORS.slice();
        let threw = false;
        try { await eng._persistCapabilitySnapshot(CAPABILITY, BLOCK); }
        catch (e) { threw = true; }
        expect(threw, 'the persist must fail closed so no checkpoint row rides a partial mirror').to.equal(true);
        expect(db.rows().length).to.equal(0);
    });

    // Structural guard for the parity the six writers' own comments claim. It names the
    // offending file directly rather than asserting an empty set, so a writer that
    // re-grows its own per-row INSERT is reported by path.
    it('every capability_snapshots writer goes through the shared helper', function () {
        const WRITERS = ['StateCheckpointEngine.js', 'CrossChainDexEngine.js', 'CrossChainCallEngine.js',
                         'OracleConsensus.js', 'RetractionConsensus.js', 'AttestationRelay.js'];
        let offenders = [];
        for (const name of WRITERS) {
            const src = fs.readFileSync(path.join(__dirname, '../../src', name), 'utf8');
            if (!/writeCapabilitySnapshotRows\(/.test(src)) offenders.push(name + ': does not call the shared writer');
            if (/INSERT IGNORE INTO capability_snapshots/.test(src)) offenders.push(name + ': still carries a per-row INSERT');
        }
        expect(offenders, 'writers must stay in lockstep on the atomic write').to.deep.equal([]);
        expect(WRITERS.length, 'the census must actually cover the six writers').to.equal(6);
    });
});
