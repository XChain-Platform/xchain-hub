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

// Read-only governance/capability list queries backing the getproposals /
// getvotes / getvalidatorcapabilities JSON-RPC methods (explorer operational
// reads, decoupled from the co-located hub DB). These assert on the SQL the
// query builders emit, since filter composition and limit clamping are the
// whole behavior.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const Governance = require('../../src/Governance');
const { createMockHub } = require('../helpers/mockHub');

const CapabilityRegistry = proxyquire('../../src/CapabilityRegistry', {
    './capabilities/index.js': {}
});

describe('governance/capability read RPC queries', function () {

    afterEach(function () {
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // Governance.getProposals(status, parameter, limit)
    // -----------------------------------------------------------------
    describe('Governance.getProposals()', function () {

        let hub, gov;
        beforeEach(function () {
            hub = createMockHub();
            gov = new Governance(hub);
        });
        afterEach(function () {
            if (gov._tallyTimer) clearInterval(gov._tallyTimer);
        });

        it('no filters: no WHERE, default LIMIT 50', async function () {
            await gov.getProposals();
            let [query, args] = hub.db.doQuery.firstCall.args;
            expect(query).to.not.contain('WHERE');
            expect(query).to.contain('LIMIT 50');
            expect(args).to.deep.equal([]);
        });

        it('status filter only', async function () {
            await gov.getProposals('voting');
            let [query, args] = hub.db.doQuery.firstCall.args;
            expect(query).to.contain('WHERE status = ?');
            expect(args).to.deep.equal(['voting']);
        });

        it('parameter filter only', async function () {
            await gov.getProposals(null, 'CAPABILITY_PRICE_MIN_STAKE');
            let [query, args] = hub.db.doQuery.firstCall.args;
            expect(query).to.contain('WHERE parameter = ?');
            expect(query).to.not.contain('status = ?');
            expect(args).to.deep.equal(['CAPABILITY_PRICE_MIN_STAKE']);
        });

        it('status + parameter compose with AND', async function () {
            await gov.getProposals('passed', 'GAS_PRICE');
            let [query, args] = hub.db.doQuery.firstCall.args;
            expect(query).to.contain('WHERE status = ? AND parameter = ?');
            expect(args).to.deep.equal(['passed', 'GAS_PRICE']);
        });

        it('limit is clamped to [1, 500]', async function () {
            await gov.getProposals(null, null, 9999);
            expect(hub.db.doQuery.firstCall.args[0]).to.contain('LIMIT 500');
            await gov.getProposals(null, null, -3);
            expect(hub.db.doQuery.secondCall.args[0]).to.contain('LIMIT 1');
            await gov.getProposals(null, null, 25);
            expect(hub.db.doQuery.thirdCall.args[0]).to.contain('LIMIT 25');
        });
    });

    // -----------------------------------------------------------------
    // Governance.getVotes({proposalId, voterPubkey, limit})
    // -----------------------------------------------------------------
    describe('Governance.getVotes()', function () {

        let hub, gov;
        beforeEach(function () {
            hub = createMockHub();
            gov = new Governance(hub);
        });
        afterEach(function () {
            if (gov._tallyTimer) clearInterval(gov._tallyTimer);
        });

        it('selects explicit columns without signature', async function () {
            await gov.getVotes();
            let [query] = hub.db.doQuery.firstCall.args;
            expect(query).to.contain('SELECT id, proposal_id, voter_pubkey, vote, created_at');
            expect(query).to.not.contain('signature');
        });

        it('filters by proposal', async function () {
            await gov.getVotes({ proposalId: 'prop-1' });
            let [query, args] = hub.db.doQuery.firstCall.args;
            expect(query).to.contain('WHERE proposal_id = ?');
            expect(args).to.deep.equal(['prop-1']);
        });

        it('filters by voter with pubkey lowercased', async function () {
            await gov.getVotes({ voterPubkey: 'AA'.repeat(32) });
            let [query, args] = hub.db.doQuery.firstCall.args;
            expect(query).to.contain('WHERE voter_pubkey = ?');
            expect(args).to.deep.equal(['aa'.repeat(32)]);
        });

        it('composes both filters and clamps limit', async function () {
            await gov.getVotes({ proposalId: 'p', voterPubkey: 'BB', limit: 100000 });
            let [query, args] = hub.db.doQuery.firstCall.args;
            expect(query).to.contain('WHERE proposal_id = ? AND voter_pubkey = ?');
            expect(query).to.contain('LIMIT 500');
            expect(args).to.deep.equal(['p', 'bb']);
        });
    });

    // -----------------------------------------------------------------
    // CapabilityRegistry.listState({signingPubkey, capability, limit})
    // -----------------------------------------------------------------
    describe('CapabilityRegistry.listState()', function () {

        function makeDb() {
            let conn = {
                query:   sinon.stub().resolves([]),
                release: sinon.stub().resolves()
            };
            return { _conn: conn, getConnection: sinon.stub().resolves(conn) };
        }

        function makeReg() {
            let db  = makeDb();
            let reg = new CapabilityRegistry({ db, p2pConfig: {} });
            return { reg, conn: db._conn };
        }

        it('no filters: selects the explorer column set, default LIMIT 200', async function () {
            let { reg, conn } = makeReg();
            await reg.listState();
            let [query, args] = conn.query.firstCall.args;
            for (let col of ['id', 'signing_pubkey', 'capability', 'qualified',
                             'self_test_ok', 'enabled', 'qualified_at_block', 'updated_at'])
                expect(query).to.contain(col);
            expect(query).to.not.contain('WHERE');
            expect(query).to.contain('LIMIT 200');
            expect(args).to.deep.equal([]);
        });

        it('filters by pubkey (lowercased) and capability', async function () {
            let { reg, conn } = makeReg();
            await reg.listState({ signingPubkey: 'CC'.repeat(32), capability: 'price' });
            let [query, args] = conn.query.firstCall.args;
            expect(query).to.contain('WHERE signing_pubkey = ? AND capability = ?');
            expect(args).to.deep.equal(['cc'.repeat(32), 'price']);
        });

        it('clamps limit and releases the connection', async function () {
            let { reg, conn } = makeReg();
            await reg.listState({ limit: 100000 });
            expect(conn.query.firstCall.args[0]).to.contain('LIMIT 500');
            expect(conn.release.calledOnce).to.equal(true);
        });

        it('releases the connection when the query throws', async function () {
            let { reg, conn } = makeReg();
            conn.query.rejects(new Error('boom'));
            try {
                await reg.listState();
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.equal('boom');
            }
            expect(conn.release.calledOnce).to.equal(true);
        });
    });
});
