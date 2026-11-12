'use strict';

/**
 * Health exposes the peer catch-up state as telemetry.
 *
 * The defect these guard: a hub whose peers all refuse its catch-up walk stayed caught_up
 * false with its published heights frozen while health read healthy with no field showing it.
 */

const { expect } = require('chai');
const sinon = require('sinon');
const { buildSystemRpc } = require('../../../src/api/rpc/system.js');

function healthFor(hub) {
    const res = { status: sinon.stub().returnsThis() };
    const rpc = buildSystemRpc({
        hub, hubConfig: {}, p2pConfig: null, configFetchCounters: { served: 0, errors: 0 },
        DB_PROBE_TIMEOUT_MS: 2000, COIN_CONSENSUS_HASHES: {}
    });
    return rpc.health({}, { res }).then((body) => ({ body, res }));
}

function stubHub(extra) {
    return Object.assign({
        network: 'regtest',
        db: { circuitState: 'closed', getDatabaseLivenessProbe: async () => true }
    }, extra);
}

describe('health catch-up state', function () {
    it('names the stuck table when catch-up is not caught up, and stays healthy', async function () {
        const stats = {
            caught_up: false, ungated: false, tables: { price_snapshots: false },
            unserved: [{ table: 'price_snapshots', reason: 'Snapshot request returned HTTP 401', peers: [] }]
        };
        const { body, res } = await healthFor(stubHub({ peerCatchup: { getStats: () => stats } }));
        expect(body.status).to.equal('healthy');
        expect(res.status.called).to.equal(false);
        expect(body.peer_catchup.caught_up).to.equal(false);
        expect(body.peer_catchup.unserved.map((u) => u.table)).to.deep.equal(['price_snapshots']);
    });

    it('reads caught_up true when caught up', async function () {
        const stats = { caught_up: true, ungated: false, tables: {}, unserved: [] };
        const { body } = await healthFor(stubHub({ peerCatchup: { getStats: () => stats } }));
        expect(body.peer_catchup.caught_up).to.equal(true);
    });

    it('omits the field without a peer catch-up and does not throw', async function () {
        const { body } = await healthFor(stubHub({}));
        expect(body).to.not.have.property('peer_catchup');
        expect(body.status).to.equal('healthy');
    });
});
