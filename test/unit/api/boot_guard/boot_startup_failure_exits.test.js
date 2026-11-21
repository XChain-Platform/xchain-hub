'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();
const { getLogger } = require('../../../../src/observability');
const { waitUntil } = require('../../../helpers/waitUntil');

function config() {
    return {
        HUB_DB_HOST: 'db', HUB_DB_PORT: '3306', HUB_DB_NAME: 'hub', HUB_DB_USER: 'user',
        HUB_PORT: '9998', HUB_API_KEY: 'key', HUB_NETWORK: '',
        env() { return this; }
    };
}

function hubRejecting(method) {
    const hub = {};
    const methods = ['start', 'startP2P', 'startConsensus', 'startOracle', 'startCrossChain',
        'startReorgHandler', 'startGovernance', 'startAttestation', 'startCapabilities'];
    for (const name of methods) hub[name] = sinon.stub().resolves();
    hub[method].rejects(new Error('simulated startup failure'));
    return hub;
}

async function bootFailure(method) {
    const hub = hubRejecting(method);
    const startServer = sinon.stub();
    const exits = [];
    const exitStub = sinon.stub(process, 'exit').callsFake(code => exits.push(code));
    const errorStub = sinon.stub(getLogger(), 'error');
    try {
        proxyquire('../../../../src/api.js', {
            './config': config(),
            './secret_env': { resolveSecretEnv: () => '' },
            './api/boot_guard': {
                requireDbSecret: () => 'secret', refuseUnsafeAuthPosture: () => {}, refuseInvalidNetwork: () => {}
            },
            './consensus/diagnostics': { installCrashHandlers: () => {} },
            './XChainHub': function () { return hub; },
            './api/server': { createApp: sinon.stub(), startServer }
        });
        await waitUntil(() => exits.length > 0, { label: 'startup rejection exit' });
        return { exits, errorStub, startServer };
    } finally {
        exitStub.restore();
        errorStub.restore();
    }
}

describe('src/api.js startup failure exit', function () {
    // The first proxyquire loads the full API dependency graph on a cold process.
    this.timeout(30000);
    afterEach(function () { sinon.restore(); });

    it('exits non-zero when the database startup rejects', async function () {
        const result = await bootFailure('start');
        expect(result.exits).to.deep.equal([1]);
        expect(result.startServer.called).to.equal(false);
        expect(result.errorStub.calledWith('FATAL_STARTUP_ERROR')).to.equal(true);
    });

    it('exits non-zero when a later subsystem startup rejects', async function () {
        const result = await bootFailure('startP2P');
        expect(result.exits).to.deep.equal([1]);
        expect(result.startServer.called).to.equal(false);
    });
});
