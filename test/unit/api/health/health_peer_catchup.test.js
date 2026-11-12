'use strict';

/**
 * The health body's peer_catchup section.
 *
 * The defect these guard: a hub whose peer catch-up no peer can serve stayed caught_up false
 * with its published heights frozen, while health read healthy with every flag green. The
 * state was visible only in the hub-db ready frame and a periodic warn line.
 */

const { expect } = require('chai');
const sinon = require('sinon');
const { buildSystemRpc } = require('../../../../src/api/rpc/system.js');
const { HUB_SCHEMA_VERSION } = require('../../../../src/hub_schema_version.js');
const { makeCatchup } = require('../../peers/hub_db/helpers/peer_catchup_harness.js');

const RES = { status() { return this; } };

function refusal(code) {
    const err = new Error('Snapshot request returned HTTP ' + code);
    err.statusCode = code;
    return err;
}

function healthFor(hub) {
    const rpc = buildSystemRpc({
        hub, hubConfig: {}, p2pConfig: null, configFetchCounters: { served: 0, errors: 0 },
        DB_PROBE_TIMEOUT_MS: 2000, COIN_CONSENSUS_HASHES: {}
    });
    return rpc.health({}, { res: RES });
}

function stubHub(extra) {
    return Object.assign({
        network: 'regtest',
        db: { circuitState: 'closed', getDatabaseLivenessProbe: async () => true }
    }, extra);
}

describe('health peer_catchup section', function () {
    it('reports an unserved catch-up with the refusal reason while staying healthy', async function () {
        const peerCatchup = makeCatchup({ bootGraceMs: 0, fetchPage: sinon.stub().rejects(refusal(401)) });
        await peerCatchup.run();
        const body = await healthFor(stubHub({ peerCatchup }));
        expect(body.status).to.equal('healthy');
        expect(body.peer_catchup.caught_up).to.equal(false);
        expect(body.peer_catchup.unserved).to.have.length(1);
        expect(body.peer_catchup.unserved[0].table).to.equal('price_snapshots');
        expect(body.peer_catchup.unserved[0].reason).to.contain('HTTP 401');
    });

    it('reports caught up with nothing unserved once a walk succeeds', async function () {
        const fetchPage = sinon.stub().resolves({ table: 'price_snapshots', schema_version: HUB_SCHEMA_VERSION, rows: [] });
        const peerCatchup = makeCatchup({ fetchPage });
        await peerCatchup.run();
        const body = await healthFor(stubHub({ peerCatchup }));
        expect(body.peer_catchup.caught_up).to.equal(true);
        expect(body.peer_catchup.unserved).to.deep.equal([]);
    });

    it('clears an unserved entry when a later walk is served', async function () {
        const fetchPage = sinon.stub();
        fetchPage.onFirstCall().rejects(refusal(404));
        fetchPage.resolves({ table: 'price_snapshots', schema_version: HUB_SCHEMA_VERSION, rows: [] });
        const peerCatchup = makeCatchup({ fetchPage });
        await peerCatchup.run();
        expect(peerCatchup.getStats().unserved).to.have.length(1);
        peerCatchup.feedBackoff.noteSuccess(peerCatchup.constructor.connectedSignerPeers(peerCatchup.peerManager)[0].feedUrl);
        await peerCatchup.run();
        expect(peerCatchup.getStats().unserved).to.deep.equal([]);
        expect(peerCatchup.getStats().caught_up).to.equal(true);
    });

    it('omits the section when the hub runs no peer catch-up', async function () {
        const body = await healthFor(stubHub({}));
        expect(body).to.not.have.property('peer_catchup');
    });
});
