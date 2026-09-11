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

// _widenUniqueKey: a widen that fails must never leave the table unconstrained.
//
// The old sequence dropped the existing UNIQUE key and then added the wider one.
// That was executed for real: the DROP ran, the ADD failed with errno 1072
// ("key column doesn't exist in table"), the index catalogue then reported no
// index at all, and a duplicate row inserted cleanly afterwards. On
// capability_snapshots that key is what keeps one signing key from being counted
// twice in the set an attestation reader trusts, so the failure mode is a
// correctness hazard rather than a hygiene one.
//
// The fake below is a small index catalogue that models the DDL the way MariaDB
// does: an ADD naming a column the table does not have fails with errno 1072, a
// duplicate index name fails with 1061, a DROP of an absent index fails with
// 1091, and information_schema answers from the same state the ALTERs mutate.
// That is what makes "the ADD failed" and "the key is gone" two separate,
// observable facts, which is exactly the pair the old code conflated.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

function dbError(code, errno, message) {
    const e = new Error(message);
    e.code  = code;
    e.errno = errno;
    return e;
}

// An in-memory table with columns and unique indexes, driven by the same SQL
// _widenUniqueKey issues. `failOn(sql, callIndex)` returns an Error to make one
// specific statement fail, which is how each failure point is pinned below.
function makeCatalogue(spec) {
    const columns = new Set((spec.columns || []).map(c => c.toLowerCase()));
    const indexes = new Map();
    for (const name of Object.keys(spec.indexes || {}))
        indexes.set(name, (spec.indexes[name] || []).map(c => c.toLowerCase()));
    const failOn = spec.failOn || (() => null);
    const sqlLog = [];

    const conn = {
        release: sinon.stub().resolves(),
        query: async function (sql, args) {
            sqlLog.push(sql);
            const forced = failOn(sql, sqlLog.length - 1);
            if (forced) throw forced;

            if (/information_schema\.statistics/i.test(sql)) {
                const cols = indexes.get(args[2]);
                if (!cols) return [];
                if (/non_unique/i.test(sql)) return [{ nu: 0 }];
                return cols.map(c => ({ col: c }));
            }
            if (/information_schema\.columns/i.test(sql))
                return [...columns].map(c => ({ col: c }));

            let m = sql.match(/ALTER TABLE (\S+) ADD UNIQUE KEY (\S+)\s*\(([^)]*)\)/i);
            if (m) {
                const cols = m[3].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
                const absent = cols.filter(c => !columns.has(c));
                if (absent.length)
                    throw dbError('ER_KEY_COLUMN_DOES_NOT_EXITS', 1072,
                        "Key column '" + absent[0] + "' doesn't exist in table");
                if (indexes.has(m[2]))
                    throw dbError('ER_DUP_KEYNAME', 1061, "Duplicate key name '" + m[2] + "'");
                indexes.set(m[2], cols);
                return {};
            }
            m = sql.match(/ALTER TABLE (\S+) DROP INDEX (\S+)/i);
            if (m) {
                if (!indexes.has(m[2]))
                    throw dbError('ER_CANT_DROP_FIELD_OR_KEY', 1091, "Can't DROP INDEX '" + m[2] + "'");
                indexes.delete(m[2]);
                return {};
            }
            return [];
        }
    };
    return { conn, indexes, sqlLog };
}

function makeDb(spec) {
    const mockConn   = { query: sinon.stub().resolves([]), release: sinon.stub().resolves(), end: sinon.stub().resolves() };
    const mockPool   = { getConnection: sinon.stub().resolves(mockConn), end: sinon.stub().resolves() };
    const Database   = proxyquire('../../src/db', {
        mariadb: { createPool: sinon.stub().returns(mockPool), createConnection: sinon.stub().resolves(mockConn) },
        fs:      { readdirSync: sinon.stub().returns([]), readFileSync: sinon.stub().returns('') }
    });
    const db        = new Database('localhost', 3306, 'test_db', 'user', 'pass');
    const catalogue = makeCatalogue(spec);
    db.getConnection = async () => catalogue.conn;
    return { db, catalogue };
}

// Does any live index enforce uniqueness over the whole target column set?
function enforcedOver(catalogue, wanted) {
    for (const cols of catalogue.indexes.values())
        if (wanted.every(c => cols.includes(c))) return true;
    return false;
}

const NARROW = ['snapshot_block', 'capability', 'signing_pubkey'];
const WIDE   = '(snapshot_block, capability, signing_pubkey, source)';

describe('Database._widenUniqueKey: a failed widen never unconstrains the table', function () {

    beforeEach(function () {
        sinon.stub(console, 'log');
        sinon.stub(console, 'error');
    });
    afterEach(function () { sinon.restore(); });

    it('widens the key in place on the happy path, leaving no temporary index behind', async function () {
        const { db, catalogue } = makeDb({
            columns: [...NARROW, 'source', 'id'],
            indexes: { uq_cap_snap: NARROW }
        });
        await db._widenUniqueKey('capability_snapshots', 'uq_cap_snap', 'source', WIDE);
        expect([...catalogue.indexes.keys()]).to.deep.equal(['uq_cap_snap']);
        expect(catalogue.indexes.get('uq_cap_snap')).to.include('source');
    });

    it('builds the wider key BEFORE dropping the old one', async function () {
        const { db, catalogue } = makeDb({
            columns: [...NARROW, 'source', 'id'],
            indexes: { uq_cap_snap: NARROW }
        });
        await db._widenUniqueKey('capability_snapshots', 'uq_cap_snap', 'source', WIDE);
        const ddl      = catalogue.sqlLog.filter(s => /^ALTER TABLE/i.test(s));
        const firstAdd = ddl.findIndex(s => /ADD UNIQUE KEY/i.test(s));
        const firstDrop = ddl.findIndex(s => /DROP INDEX/i.test(s));
        expect(firstAdd, 'no ADD was issued').to.be.at.least(0);
        expect(firstDrop, 'no DROP was issued').to.be.at.least(0);
        expect(firstAdd).to.be.lessThan(firstDrop);
    });

    // The exact production incident. The widen column is missing, so every ADD
    // naming it fails with errno 1072. The old order dropped first and left zero
    // indexes; this order must leave the narrow key untouched.
    it('leaves the original key in place when the widen column is not on the table', async function () {
        const { db, catalogue } = makeDb({
            columns: [...NARROW, 'id'],                 // no `source` column
            indexes: { uq_cap_snap: NARROW }
        });
        await db._widenUniqueKey('capability_snapshots', 'uq_cap_snap', 'source', WIDE);
        expect(catalogue.indexes.has('uq_cap_snap'), 'the original key was dropped').to.be.true;
        expect(catalogue.indexes.get('uq_cap_snap')).to.deep.equal(NARROW);
        expect(enforcedOver(catalogue, NARROW)).to.be.true;
    });

    it('names the table, the index and the repair statement when it skips the widen', async function () {
        const { db } = makeDb({ columns: [...NARROW, 'id'], indexes: { uq_cap_snap: NARROW } });
        await db._widenUniqueKey('capability_snapshots', 'uq_cap_snap', 'source', WIDE);
        const line = console.error.getCalls().map(c => String(c.args[0])).join('\n');
        expect(line).to.match(/capability_snapshots/);
        expect(line).to.match(/uq_cap_snap/);
        expect(line).to.match(/source/);
        expect(line).to.match(/ADD UNIQUE KEY uq_cap_snap/);
    });

    // Same failure reached the other way: the preflight cannot see the column list
    // (an information_schema read that returns nothing), so the ADD itself is what
    // fails. The temporary key never appears, so the old key is still never dropped.
    it('keeps the old key when the wider ADD fails and the preflight could not judge', async function () {
        const { db, catalogue } = makeDb({
            columns: [],                                 // column read answers nothing
            indexes: { uq_reward: ['validator_pubkey', 'round_number', 'reward_type'] },
            failOn: (sql) => (/ADD UNIQUE KEY uq_reward_widening/i.test(sql)
                ? dbError('ER_KEY_COLUMN_DOES_NOT_EXITS', 1072, "Key column 'round_qualifier' doesn't exist in table")
                : null)
        });
        await db._widenUniqueKey('validator_rewards', 'uq_reward', 'round_qualifier',
            '(validator_pubkey, round_number, reward_type, round_qualifier)');
        expect(catalogue.indexes.has('uq_reward')).to.be.true;
        expect(catalogue.indexes.get('uq_reward')).to.deep.equal(
            ['validator_pubkey', 'round_number', 'reward_type']);
    });

    // Failure point: the DROP of the old key. Both keys are live; the wider one is
    // already enforcing, so nothing is lost and the boot continues.
    it('survives a failed DROP of the old key, with the wider key already enforcing', async function () {
        const { db, catalogue } = makeDb({
            columns: [...NARROW, 'source', 'id'],
            indexes: { uq_cap_snap: NARROW },
            failOn: (sql) => (/DROP INDEX uq_cap_snap$/i.test(sql)
                ? dbError('ER_LOCK_WAIT_TIMEOUT', 1205, 'Lock wait timeout exceeded') : null)
        });
        await db._widenUniqueKey('capability_snapshots', 'uq_cap_snap', 'source', WIDE);
        expect(enforcedOver(catalogue, [...NARROW, 'source'])).to.be.true;
        expect(catalogue.indexes.has('uq_cap_snap')).to.be.true;
    });

    // Failure point: re-adding under the real name after the old key is gone. The
    // temporary key is still there and still unique, so the table stays constrained
    // and the hub is allowed to boot.
    it('boots on the temporary key when the re-add under the real name fails', async function () {
        let seenAdds = 0;
        const { db, catalogue } = makeDb({
            columns: [...NARROW, 'source', 'id'],
            indexes: { uq_cap_snap: NARROW },
            failOn: (sql) => {
                if (!/ADD UNIQUE KEY uq_cap_snap\s*\(/i.test(sql)) return null;
                return (++seenAdds >= 1) ? dbError('ER_LOCK_WAIT_TIMEOUT', 1205, 'Lock wait timeout exceeded') : null;
            }
        });
        await db._widenUniqueKey('capability_snapshots', 'uq_cap_snap', 'source', WIDE);
        expect(catalogue.indexes.has('uq_cap_snap_widening'), 'nothing is enforcing uniqueness').to.be.true;
        expect(enforcedOver(catalogue, [...NARROW, 'source'])).to.be.true;
    });

    // A later boot finds the temporary key and finishes the job: the real name is
    // rebuilt and the temporary one retired, without ever passing through a state
    // where neither exists.
    it('completes an interrupted widen on the next boot', async function () {
        const { db, catalogue } = makeDb({
            columns: [...NARROW, 'source', 'id'],
            indexes: { uq_cap_snap_widening: [...NARROW, 'source'] }
        });
        await db._widenUniqueKey('capability_snapshots', 'uq_cap_snap', 'source', WIDE);
        expect([...catalogue.indexes.keys()]).to.deep.equal(['uq_cap_snap']);
        expect(catalogue.indexes.get('uq_cap_snap')).to.include('source');
    });

    // The fail-closed guard, end to end: the temporary key builds, the old key
    // drops, and then the table loses BOTH (the re-add fails and the temporary key
    // goes with it). That is the state the old code shipped silently. Here it must
    // take the boot down instead, because runMigrations is awaited unguarded during
    // hub start and an unconstrained capability_snapshots feeds the validator set.
    it('refuses to start when the key is gone and cannot be rebuilt', async function () {
        const held = {};
        const { db, catalogue } = makeDb({
            columns: [...NARROW, 'source', 'id'],
            indexes: { uq_cap_snap: NARROW },
            failOn: (sql) => {
                if (!/ADD UNIQUE KEY uq_cap_snap\s*\(/i.test(sql)) return null;
                held.catalogue.indexes.clear();     // the wider key is lost too
                return dbError('ER_UNKNOWN_ERROR', 1105, 'server went away');
            }
        });
        held.catalogue = catalogue;

        let thrown = null;
        try {
            await db._widenUniqueKey('capability_snapshots', 'uq_cap_snap', 'source', WIDE);
        } catch (e) { thrown = e; }

        expect(thrown, 'the hub started with an unconstrained table').to.be.an('error');
        expect(thrown.message).to.match(/Refusing to start/);
        expect(thrown.message).to.match(/capability_snapshots/);
        expect(thrown.message).to.match(/uq_cap_snap/);
        expect(thrown.message).to.match(/ADD UNIQUE KEY uq_cap_snap/);
        expect(enforcedOver(catalogue, NARROW), 'the table is unconstrained').to.be.false;
    });

    it('the guard passes, with a warning, while only the temporary key is live', async function () {
        const { db, catalogue } = makeDb({
            columns: [...NARROW, 'source', 'id'],
            indexes: { uq_cap_snap_widening: [...NARROW, 'source'] }
        });
        await db._assertUniqueKeyStillEnforced(catalogue.conn, 'capability_snapshots',
            'uq_cap_snap', 'uq_cap_snap_widening', 'ALTER TABLE capability_snapshots ADD UNIQUE KEY uq_cap_snap ' + WIDE);
        const warned = console.error.getCalls().map(c => String(c.args[0])).join('\n');
        expect(warned).to.match(/uq_cap_snap_widening/);
    });

    // A probe that cannot answer is not evidence that the key is fine.
    it('the guard fails closed when the index catalogue cannot be read', async function () {
        const { db, catalogue } = makeDb({
            columns: [...NARROW, 'source', 'id'],
            indexes: { uq_cap_snap: NARROW },
            failOn: (sql) => (/information_schema\.statistics/i.test(sql)
                ? dbError('ER_UNKNOWN_ERROR', 1105, 'server went away') : null)
        });
        let thrown = null;
        try {
            await db._assertUniqueKeyStillEnforced(catalogue.conn, 'capability_snapshots',
                'uq_cap_snap', 'uq_cap_snap_widening', 'ALTER TABLE t ADD UNIQUE KEY uq_cap_snap ' + WIDE);
        } catch (e) { thrown = e; }
        expect(thrown).to.be.an('error');
        expect(thrown.message).to.match(/Refusing to start/);
    });

    it('is a no-op once the live key already covers the widen column', async function () {
        const { db, catalogue } = makeDb({
            columns: [...NARROW, 'source', 'id'],
            indexes: { uq_cap_snap: [...NARROW, 'source'] }
        });
        await db._widenUniqueKey('capability_snapshots', 'uq_cap_snap', 'source', WIDE);
        expect(catalogue.sqlLog.some(s => /^ALTER TABLE/i.test(s)), 'DDL ran on an already-wide key').to.be.false;
    });
});
