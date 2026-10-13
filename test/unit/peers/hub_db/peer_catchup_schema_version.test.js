'use strict';
const sinon = require('sinon');
const { expect } = require('chai');
const { HUB_SCHEMA_VERSION } = require('../../../../src/hub_schema_version.js');
const HubDbPeerCatchup = require('../../../../src/peers/hub_db/peer_catchup.js');
const { pageSnapshotTable } = require('../../../../src/peers/hub_db/catchup_pager.js');

const TABLE = 'price_snapshots';
const PEER = 'ws://peer-a:8080';

function makeCatchup(fetchPage, storeRow) {
    const catchup = new HubDbPeerCatchup({
        db: {}, peerManager: {}, fetchPage, tables: [TABLE], pageSize: 2,
        getVerifier: () => async () => ({ ok: true }),
        hasRow: async () => false, storeRow,
        logger: { warn: sinon.stub(), info: sinon.stub() }
    });
    return catchup;
}

function walk(catchup) {
    return catchup.catchUpTable(PEER, TABLE, async () => ({ ok: true }), 'peer-a', null);
}

describe('hub DB catch-up schema_version check', function () {
    afterEach(function () { sinon.restore(); });

    for (const [label, version] of [['older', HUB_SCHEMA_VERSION - 1], ['newer', HUB_SCHEMA_VERSION + 1], ['missing', undefined]]) {
        it('catchUpTable refuses a page from a ' + label + ' schema and stores nothing', async function () {
            const storeRow = sinon.stub().resolves();
            const fetchPage = sinon.stub().resolves({ table: TABLE, schema_version: version, rows: [{ id: 1 }] });
            let error;
            try { await walk(makeCatchup(fetchPage, storeRow)); } catch (e) { error = e; }
            expect(error).to.be.an('error');
            expect(error.message).to.match(/schema_version/);
            expect(storeRow.called).to.equal(false);
        });

        it('the pager refuses a response from a ' + label + ' schema before handing off a row', async function () {
            const onRow = sinon.stub().resolves();
            const result = await pageSnapshotTable({
                table: TABLE, onRow,
                fetchPage: async () => ({ table: TABLE, schema_version: version, rows: [{ id: 1 }] })
            });
            expect(result.complete).to.equal(false);
            expect(result.error.message).to.match(/schema_version/);
            expect(onRow.called).to.equal(false);
        });
    }

    it('catchUpTable accepts a page stamped with HUB_SCHEMA_VERSION', async function () {
        const storeRow = sinon.stub().resolves();
        const fetchPage = sinon.stub().resolves({ table: TABLE, schema_version: HUB_SCHEMA_VERSION, rows: [{ id: 1 }] });
        await walk(makeCatchup(fetchPage, storeRow));
        expect(storeRow.calledOnce).to.equal(true);
    });

    it('walkTable backs the refusing feed off and leaves the table state unchanged', async function () {
        const fetchPage = sinon.stub().resolves({ table: TABLE, schema_version: HUB_SCHEMA_VERSION + 1, rows: [] });
        const catchup = makeCatchup(fetchPage, sinon.stub().resolves());
        await catchup.walkTable([{ feedUrl: PEER, identity: 'peer-a' }], TABLE, async () => ({ ok: true }), null);
        expect(catchup.feedBackoff.isBackedOff(PEER)).to.equal(true);
        expect(catchup.tableCaughtUp(TABLE)).to.equal(false);
    });
});
