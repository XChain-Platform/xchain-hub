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
//
// A limit that validateLimit accepts as a digit string must reach the DB layer as a
// number, and the price finders must never bind a string into a `LIMIT ?` slot
// (MariaDB rejects the quoted value with errno 1064).

const sinon      = require('sinon');
const { expect } = require('chai');
const { buildOracleRpc } = require('../../../../src/api/rpc/oracle.js');
const finders = require('../../../../src/db/prices/newest_page.js');

const FORMS = [['50', 50], ['0050', 50], ['050', 50], ['1', 1], ['10000', 10000]];

describe('getpricesnapshots digit-string limit reaches the DB as a number', function () {
    for (const status of [undefined, 'all']) {
        it('handler hands the DB layer the numeric twin (status ' + status + ')', async function () {
            const db = {
                findPriceSnapshotsFinalized: sinon.stub().resolves([]),
                findPriceSnapshotsAnyStatus: sinon.stub().resolves([]),
            };
            const hub = { getPriceSnapshots: (l, s) => s === 'all'
                ? db.findPriceSnapshotsAnyStatus(l || 50) : db.findPriceSnapshotsFinalized(l || 50) };
            const rpc = buildOracleRpc({ hub });
            for (const [s, n] of FORMS) {
                const out = await rpc.getpricesnapshots({ limit: s, status });
                expect(out).to.not.have.property('error');
                const stub = status === 'all' ? db.findPriceSnapshotsAnyStatus : db.findPriceSnapshotsFinalized;
                const arg = stub.lastCall.args[0];
                expect(typeof arg).to.equal('number');
                expect(arg).to.equal(n);
            }
        });
    }

    it('invalid limits stay refused', async function () {
        const rpc = buildOracleRpc({ hub: { getPriceSnapshots: sinon.stub().resolves([]) } });
        for (const bad of ['50junk', '1e3', 0, 10001]) {
            expect(await rpc.getpricesnapshots({ limit: bad })).to.have.property('error');
        }
    });

    describe('real finders never bind a string LIMIT', function () {
        function ctx(boundaryRows) {
            const calls = [];
            return {
                calls,
                doQuery: async (sql, params) => {
                    calls.push({ sql, params });
                    if (/OFFSET/.test(sql)) return boundaryRows;
                    for (const p of params) if (typeof p === 'string') throw new Error('string bind ' + p);
                    return [];
                },
            };
        }
        for (const name of ['findPriceSnapshotsAnyStatus', 'findPriceSnapshotsFinalized']) {
            for (const [label, rows] of [['fallback', []], ['boundary', [{ round_number: 9 }]]]) {
                it(name + ' ' + label + ' branch', async function () {
                    for (const [s] of FORMS) {
                        const c = ctx(rows);
                        await finders[name].call(c, s);
                        const last = c.calls[c.calls.length - 1];
                        expect(typeof last.params[last.params.length - 1]).to.equal('number');
                        expect(last.params[last.params.length - 1]).to.equal(Number(s));
                    }
                });
            }
        }
    });
});
