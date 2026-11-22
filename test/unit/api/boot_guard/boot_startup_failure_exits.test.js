'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '../../../..');

function bootFailure(method) {
    const script = `
        const path = require('path');
        const proxyquire = require('proxyquire').noPreserveCache();
        const config = {
            HUB_DB_HOST: 'db', HUB_DB_PORT: '3306', HUB_DB_NAME: 'hub', HUB_DB_USER: 'user',
            HUB_PORT: '9998', HUB_API_KEY: 'key', HUB_NETWORK: '', env() { return this; }
        };
        const hub = {};
        for (const name of ${JSON.stringify([
            'start', 'startP2P', 'startConsensus', 'startOracle', 'startCrossChain',
            'startReorgHandler', 'startGovernance', 'startAttestation', 'startCapabilities'
        ])}) hub[name] = async () => {};
        hub[${JSON.stringify(method)}] = async () => { throw new Error('simulated startup failure'); };
        proxyquire(path.join(process.cwd(), 'src/api.js'), {
            './config': config,
            './observability': {
                patchConsole() {},
                getLogger: () => ({ error(event) { process.stderr.write(event + '\\n'); } })
            },
            './secret_env': { resolveSecretEnv: () => '' },
            './api/boot_guard': {
                requireDbSecret: () => 'secret', refuseUnsafeAuthPosture() {}, refuseInvalidNetwork() {}
            },
            './consensus/diagnostics': { installCrashHandlers() {} },
            './XChainHub': function () { return hub; },
            './api/server': {
                createApp() { process.stderr.write('CREATE_APP_CALLED\\n'); return {}; },
                startServer() { process.stderr.write('START_SERVER_CALLED\\n'); }
            }
        });
    `;
    return spawnSync(process.execPath, ['-e', script], {
        cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000
    });
}

function expectFatalExit(result) {
    expect(result.error).to.equal(undefined);
    expect(result.signal).to.equal(null);
    expect(result.status).to.equal(1);
    expect(result.stderr).to.include('FATAL_STARTUP_ERROR');
    expect(result.stderr).not.to.include('CREATE_APP_CALLED');
    expect(result.stderr).not.to.include('START_SERVER_CALLED');
}

describe('src/api.js startup failure exit', function () {
    this.timeout(30000);

    it('exits non-zero when the database startup rejects', function () {
        const result = bootFailure('start');
        expectFatalExit(result);
    });

    it('exits non-zero when a later subsystem startup rejects', function () {
        const result = bootFailure('startP2P');
        expectFatalExit(result);
    });
});
