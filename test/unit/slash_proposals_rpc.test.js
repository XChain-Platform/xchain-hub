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

// The public slash-proposal read surface: SlashDetector.getSlashProposals()
// and the `getslashproposals` JSON-RPC method that fronts it (explorer M3.6).
//
// Operator ruling 2026-08-20: publish ALL statuses, with pending rows labelled
// as unadjudicated, and return the evidence as a HASH rather than verbatim.
// The hashing is deliberately a HUB-SIDE leg: this RPC answers any caller on
// the hub's own POST surface, so redacting in one downstream consumer (the
// explorer) would leave the verbatim accusation text readable straight off the
// hub. The "verbatim evidence never leaves the hub" tests below are the
// enforcement of that, and are the reason this file exists.
//
// Schema (xchain-hub/src/sql/slash_proposals.sql):
//   id               BIGINT AUTO_INCREMENT PRIMARY KEY
//   validator_pubkey CHAR(64)      -- 64 hex, lowercased on write
//   offense_type     VARCHAR(30)   -- price_deviation | repeated_deviation |
//                                  -- non_participation | attestation_divergence
//   round_number     BIGINT
//   evidence         TEXT          -- verbatim JSON written by SlashDetector
//   status           ENUM('pending','approved','rejected','expired')
//   created_at       TIMESTAMP
// No chain/network column: slash proposals are federation-wide (oracle rounds
// and attestation rounds are not per-chain), so this surface is platform-global
// like validator_capabilities and governance_proposals, unlike
// reorg_attestations (which carries source_chain).

const crypto     = require('crypto');
const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();

const SlashDetector    = require('../../src/SlashDetector');
const SlashGovernance  = require('../../src/SlashGovernance');
const { createMockHub } = require('../helpers/mockHub');
const { waitUntil }     = require('../helpers/waitUntil');

const PK  = 'a'.repeat(64);
const PK2 = 'b'.repeat(64);

function makeDetector() {
    let hub = createMockHub({
        p2pConfig: {
            SLASH_DEVIATION_THRESHOLD:     '0.05',
            SLASH_MISSED_ROUNDS_THRESHOLD: '30'
        }
    });
    return { hub, sd: new SlashDetector(hub) };
}

function dbRow(over = {}) {
    return {
        id: 7,
        validator_pubkey: PK,
        offense_type: 'non_participation',
        round_number: 412,
        evidence: '{"missedRounds":30,"windowRounds":60,"participationRate":"0.5000"}',
        status: 'pending',
        created_at: '2026-08-20T00:00:00.000Z',
        ...over
    };
}

describe('SlashDetector.getSlashProposals() (public read surface)', function () {

    let hub, sd;
    beforeEach(function () {
        ({ hub, sd } = makeDetector());
        hub.db.doQuery.resolves([]);
    });
    afterEach(function () { sinon.restore(); });

    // -----------------------------------------------------------------
    // The security leg: verbatim evidence must never leave the hub
    // -----------------------------------------------------------------

    describe('evidence redaction (the 2026-08-20 ruling, hub-side)', function () {

        it('never returns the verbatim evidence blob on any row', async function () {
            hub.db.doQuery.resolves([dbRow(), dbRow({ id: 8, status: 'approved' })]);
            let rows = await sd.getSlashProposals();
            for (let r of rows) {
                expect(r).to.not.have.property('evidence');
                expect(JSON.stringify(r)).to.not.contain('missedRounds');
            }
        });

        it('publishes evidence_hash = sha256(evidence) instead', async function () {
            let row = dbRow();
            hub.db.doQuery.resolves([row]);
            let [out] = await sd.getSlashProposals();
            expect(out.evidence_hash).to.equal(
                crypto.createHash('sha256').update(row.evidence).digest('hex'));
            expect(out.evidence_hash).to.match(/^[0-9a-f]{64}$/);
        });

        it('is stable across reads, so a third party holding the blob can verify a published hash', async function () {
            hub.db.doQuery.resolves([dbRow()]);
            let [first]  = await sd.getSlashProposals();
            let [second] = await sd.getSlashProposals();
            expect(first.evidence_hash).to.equal(second.evidence_hash);
        });

        it('hashes a NULL evidence column as the empty string rather than emitting null', async function () {
            hub.db.doQuery.resolves([dbRow({ evidence: null })]);
            let [out] = await sd.getSlashProposals();
            expect(out.evidence_hash).to.equal(
                crypto.createHash('sha256').update('').digest('hex'));
        });

        it('builds the row from an allowlist, so a column added to slash_proposals later cannot publish itself', async function () {
            // A `delete r.evidence` implementation would pass the tests above and
            // still leak the day someone adds a raw_report / reporter_ip column.
            hub.db.doQuery.resolves([dbRow({ future_secret_column: 'must not be published' })]);
            let [out] = await sd.getSlashProposals();
            expect(out).to.not.have.property('future_secret_column');
            expect(Object.keys(out).sort()).to.deep.equal([
                'created_at', 'evidence_hash', 'id', 'offense_type',
                'round_number', 'status', 'validator_pubkey'
            ]);
        });

        it('serves status on EVERY row, since status is the only thing separating an accusation from a finding', async function () {
            hub.db.doQuery.resolves([dbRow(), dbRow({ id: 8, status: 'rejected' })]);
            let rows = await sd.getSlashProposals();
            expect(rows.map(r => r.status)).to.deep.equal(['pending', 'rejected']);
        });
    });

    // -----------------------------------------------------------------
    // Hash construction: byte-identical to SlashGovernance's per-row leg
    // -----------------------------------------------------------------

    describe('hash construction parity with SlashGovernance', function () {

        it('hashEvidence() is the exact per-row leg of computeEvidenceHash(), so a published hash re-derives the voted evidence hash', function () {
            // computeEvidenceHash builds each row key as
            //   pubkey|offense_type|round_number|sha256(evidence)
            // and sha256s the sorted join. If the published per-row digest were a
            // different construction (canonicalized JSON, a different algorithm, a
            // salt), an auditor could not go from published rows to the
            // SLASH_PENALTY parameter's hash, which is the whole point of
            // publishing a hash rather than nothing.
            let row = dbRow();
            let key = row.validator_pubkey.toLowerCase() + '|' + row.offense_type + '|' +
                      row.round_number + '|' + SlashDetector.hashEvidence(row.evidence);
            let expected = crypto.createHash('sha256').update(key).digest('hex');
            expect(SlashGovernance.computeEvidenceHash([row])).to.equal(expected);
        });

        it('agrees with SlashGovernance on a null evidence column too', function () {
            let row = dbRow({ evidence: null });
            let key = row.validator_pubkey.toLowerCase() + '|' + row.offense_type + '|' +
                      row.round_number + '|' + SlashDetector.hashEvidence(row.evidence);
            expect(SlashGovernance.computeEvidenceHash([row]))
                .to.equal(crypto.createHash('sha256').update(key).digest('hex'));
        });

        it('is a plain unsalted digest (verifiable by an outsider), not an HMAC', function () {
            expect(SlashDetector.hashEvidence('x'))
                .to.equal(crypto.createHash('sha256').update('x').digest('hex'));
        });
    });

    // -----------------------------------------------------------------
    // Query shape: filters, bound, order
    // -----------------------------------------------------------------

    describe('query shape', function () {

        it('no filters: no WHERE, default LIMIT 50, no args', async function () {
            await sd.getSlashProposals();
            let [query, args] = hub.db.doQuery.firstCall.args;
            expect(query).to.not.contain('WHERE');
            expect(query).to.contain('LIMIT 50');
            expect(args).to.deep.equal([]);
        });

        it('publishes ALL statuses by default (ruling (b)), unlike getPendingProposals', async function () {
            await sd.getSlashProposals();
            let [query] = hub.db.doQuery.firstCall.args;
            expect(query).to.not.contain("status = 'pending'");
        });

        it('status filter binds a placeholder', async function () {
            await sd.getSlashProposals({ status: 'approved' });
            let [query, args] = hub.db.doQuery.firstCall.args;
            expect(query).to.contain('WHERE status = ?');
            expect(args).to.deep.equal(['approved']);
        });

        it('validator pubkey filter binds a lowercased placeholder', async function () {
            await sd.getSlashProposals({ validatorPubkey: PK2.toUpperCase() });
            let [query, args] = hub.db.doQuery.firstCall.args;
            expect(query).to.contain('WHERE validator_pubkey = ?');
            expect(args).to.deep.equal([PK2]);
        });

        it('both filters compose with AND, in signature order', async function () {
            await sd.getSlashProposals({ status: 'pending', validatorPubkey: PK });
            let [query, args] = hub.db.doQuery.firstCall.args;
            expect(query).to.contain('WHERE status = ? AND validator_pubkey = ?');
            expect(args).to.deep.equal(['pending', PK]);
        });

        it('rejects an unknown status rather than silently returning zero rows', async function () {
            let err = null;
            try { await sd.getSlashProposals({ status: 'guilty' }); } catch (e) { err = e; }
            expect(err).to.be.an('error');
            expect(err.message).to.contain('status must be one of');
            expect(hub.db.doQuery.called).to.equal(false);
        });

        it('rejects a malformed validator pubkey', async function () {
            let err = null;
            try { await sd.getSlashProposals({ validatorPubkey: 'nope' }); } catch (e) { err = e; }
            expect(err).to.be.an('error');
            expect(err.message).to.contain('64 hex');
            expect(hub.db.doQuery.called).to.equal(false);
        });

        it('orders by id DESC, matching the AUTO_INCREMENT cursor the explorer pages on', async function () {
            // created_at is a second-granularity TIMESTAMP and ties within a burst
            // of detections, which would split a keyset page boundary.
            await sd.getSlashProposals();
            let [query] = hub.db.doQuery.firstCall.args;
            expect(query).to.contain('ORDER BY id DESC');
            expect(query).to.not.contain('ORDER BY created_at');
        });

        it('selects only the seven published columns plus evidence (needed to hash)', async function () {
            await sd.getSlashProposals();
            let [query] = hub.db.doQuery.firstCall.args;
            expect(query).to.contain(
                'SELECT id, validator_pubkey, offense_type, round_number, evidence, status, created_at');
            expect(query).to.not.contain('SELECT *');
        });

        it('tolerates a driver returning null instead of an empty array', async function () {
            hub.db.doQuery.resolves(null);
            expect(await sd.getSlashProposals()).to.deep.equal([]);
        });
    });

    // -----------------------------------------------------------------
    // The bounded limit its getPendingProposals starting point lacks
    // -----------------------------------------------------------------

    describe('server-side page bound', function () {

        it('caps at 500 even when the caller asks for the API-layer maximum of 10000', async function () {
            // validateLimit at the API layer admits anything up to 10000; without
            // this clamp the RPC would hand out 10000 rows per call. Every sibling
            // list RPC the explorer reads (getproposals/getvotes) caps at 500
            // server-side, and so must this one.
            await sd.getSlashProposals({ limit: 10000 });
            expect(hub.db.doQuery.firstCall.args[0]).to.contain('LIMIT 500');
        });

        it('honours a smaller caller limit', async function () {
            await sd.getSlashProposals({ limit: 25 });
            expect(hub.db.doQuery.firstCall.args[0]).to.contain('LIMIT 25');
        });

        it('accepts a numeric string limit', async function () {
            await sd.getSlashProposals({ limit: '250' });
            expect(hub.db.doQuery.firstCall.args[0]).to.contain('LIMIT 250');
        });

        it('falls back to the default for 0, an absent, or a non-numeric limit', async function () {
            for (let bad of [0, 'lots', null, undefined]) {
                hub.db.doQuery.resetHistory();
                await sd.getSlashProposals({ limit: bad });
                expect(hub.db.doQuery.firstCall.args[0], 'limit=' + bad).to.contain('LIMIT 50');
            }
        });

        it('clamps a negative limit up to 1, never emitting a negative LIMIT', async function () {
            // Same arithmetic as Governance.getProposals/getVotes: a negative is
            // truthy, so it survives the `|| DEFAULT_PAGE` and is caught by the
            // Math.max floor. Pinned rather than "fixed" so the three sibling list
            // RPCs keep one limit contract.
            await sd.getSlashProposals({ limit: -5 });
            expect(hub.db.doQuery.firstCall.args[0]).to.contain('LIMIT 1');
        });

        it('interpolates the clamped integer, never the caller value (no injection surface)', async function () {
            await sd.getSlashProposals({ limit: '5; DROP TABLE slash_proposals' });
            let [query] = hub.db.doQuery.firstCall.args;
            expect(query).to.contain('LIMIT 5');
            expect(query).to.not.contain('DROP');
        });

        it('exports the cap so consumers can page against the same number', function () {
            expect(SlashDetector.MAX_PAGE).to.equal(500);
        });
    });

    it('getPendingProposals() is unchanged (internal all-pending read, still unbounded by design)', async function () {
        hub.db.doQuery.resolves([{ id: 1 }]);
        await sd.getPendingProposals();
        let [query] = hub.db.doQuery.firstCall.args;
        expect(query).to.contain("status = 'pending'");
    });
});

// ---------------------------------------------------------------------
// The RPC leg. Boots src/api.js with everything heavy stubbed and captures
// the real jsonRpcController object handed to express-json-rpc-router, so
// these drive the SHIPPED handler rather than a copy of it (same boot
// technique as test/unit/sensitiveReadAuth.test.js).
// ---------------------------------------------------------------------

async function bootController(slashDetector) {
    const mockApp = {
        use: sinon.stub(), get: sinon.stub(), post: sinon.stub(), set: sinon.stub(),
        listen: sinon.stub().callsFake((port, host, cb) => { if (cb) cb(); })
    };
    const mockServer = {
        listen: sinon.stub().callsFake((port, host, cb) => { if (cb) cb(); }),
        on: sinon.stub()
    };
    const mockExpress = sinon.stub().returns(mockApp);
    mockExpress.json = sinon.stub().returns(function expressJson() {});

    const mockHub = new Proxy({ slashDetector }, {
        get: (target, prop) => {
            if (!(prop in target)) target[prop] = sinon.stub().callsFake(async () => ({}));
            return target[prop];
        }
    });

    let controller = null;
    const saved = {};
    for (const k of ['HUB_API_KEY', 'HUB_REORG_API_KEY', 'HUB_SENSITIVE_READ_AUTH',
                     'HUB_ALLOW_UNAUTHENTICATED', 'HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME',
                     'HUB_DB_USER', 'HUB_DB_PASS', 'HUB_PORT', 'P2P_VALIDATOR_ADDR']) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
    // HUB_ALLOW_UNAUTHENTICATED: api.js refuses to boot with neither that nor
    // HUB_API_KEY set. This suite is about the PUBLIC read tier, so the keyless
    // shape is the one to boot; test/unit/sensitiveReadAuth.test.js owns the
    // keyed-tier behavior.
    Object.assign(process.env, {
        HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb',
        HUB_DB_USER: 'root', HUB_DB_PASS: 'pass', HUB_PORT: '9998',
        HUB_ALLOW_UNAUTHENTICATED: 'true'
    });
    try {
        proxyquire('../../src/api', {
            'dotenv': { config: sinon.stub() },
            'express': mockExpress,
            'helmet': sinon.stub().returns(function helmetMw() {}),
            'cors': sinon.stub().returns(function corsMw() {}),
            'express-rate-limit': sinon.stub().returns(function rateLimitMw() {}),
            'express-json-rpc-router': (opts) => { controller = opts.methods; return function routerMw() {}; },
            'http': { createServer: sinon.stub().returns(mockServer) },
            'ws': { Server: sinon.stub().returns({ on: sinon.stub() }) },
            'geoip-lite': { lookup: sinon.stub().returns(null) },
            './XChainHub': function () { return mockHub; }
        });
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
    await waitUntil(() => controller !== null, { label: 'api.js boot to register the JSON-RPC controller' });
    return controller;
}

describe('getslashproposals JSON-RPC method', function () {

    this.timeout(20000);

    afterEach(function () { sinon.restore(); });

    it('is registered on the JSON-RPC controller', async function () {
        const c = await bootController({ getSlashProposals: sinon.stub().resolves([]) });
        expect(c.getslashproposals).to.be.a('function');
    });

    it('forwards status and maps validator_pubkey to the detector argument name', async function () {
        const getSlashProposals = sinon.stub().resolves([]);
        const c = await bootController({ getSlashProposals });
        await c.getslashproposals({ status: 'pending', validator_pubkey: PK, limit: 100 });
        expect(getSlashProposals.firstCall.args[0]).to.deep.equal({
            status: 'pending', validatorPubkey: PK, limit: 100
        });
    });

    it('returns the detector rows verbatim (evidence already stripped hub-side)', async function () {
        const rows = [{
            id: 7, validator_pubkey: PK, offense_type: 'non_participation',
            round_number: 412, evidence_hash: 'f'.repeat(64), status: 'pending',
            created_at: '2026-08-20T00:00:00.000Z'
        }];
        const c = await bootController({ getSlashProposals: sinon.stub().resolves(rows) });
        const out = await c.getslashproposals({});
        expect(out).to.deep.equal(rows);
        expect(JSON.stringify(out)).to.not.contain('"evidence"');
    });

    it('rejects a limit above the shared validateLimit ceiling before touching the detector', async function () {
        const getSlashProposals = sinon.stub().resolves([]);
        const c = await bootController({ getSlashProposals });
        const out = await c.getslashproposals({ limit: 10001 });
        expect(out.error).to.contain('10000');
        expect(getSlashProposals.called).to.equal(false);
    });

    it('rejects a non-integer limit', async function () {
        const c = await bootController({ getSlashProposals: sinon.stub().resolves([]) });
        expect((await c.getslashproposals({ limit: '50junk' })).error).to.contain('limit');
    });

    it('reports a clear error when the slash detector is not active', async function () {
        const c = await bootController(undefined);
        expect((await c.getslashproposals({})).error).to.contain('slash detector not active');
    });

    it('surfaces the detector argument-validation message to the caller', async function () {
        const c = await bootController({
            getSlashProposals: sinon.stub().rejects(new Error('status must be one of: pending, approved, rejected, expired'))
        });
        expect((await c.getslashproposals({ status: 'guilty' })).error).to.contain('status must be one of');
    });

    it('is a PUBLIC read: not keyed as a write and not in the sensitive-read tier', async function () {
        // The rows carry no credential and no mesh-internal connection state, so
        // (per the seam contract, section 5) no auth-set change is needed. This
        // pins that decision: a later edit that adds it to WRITE_METHODS would
        // break every unauthenticated explorer read, and one that adds it to
        // SENSITIVE_READ_METHODS would 401 the explorer whenever HUB_API_KEY is set.
        const fs  = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
        const writeBlock = src.slice(src.indexOf('WRITE_METHODS'), src.indexOf(']', src.indexOf('WRITE_METHODS')));
        const sensIdx    = src.indexOf('SENSITIVE_READ_METHODS = new Set(');
        const sensBlock  = src.slice(sensIdx, src.indexOf(')', sensIdx));
        expect(writeBlock).to.not.contain('getslashproposals');
        expect(sensBlock).to.not.contain('getslashproposals');
    });

    it('is documented in the published OpenRPC contract as a non-auth method', function () {
        const doc = require('../../docs/openrpc.json');
        const m = doc.methods.find(x => x.name === 'getslashproposals');
        expect(m, 'regenerate with: node docs/openrpc.build.js').to.be.an('object');
        expect(m['x-auth']).to.equal(undefined);
        expect(m.params.map(p => p.name)).to.deep.equal(['status', 'validator_pubkey', 'limit']);
        // The contract has to say what a 'pending' row means, because a JSON
        // consumer sees only the word 'pending' otherwise.
        expect(m.summary.toLowerCase()).to.contain('unadjudicated');
        expect(m.summary).to.contain('evidence_hash');
    });
});
