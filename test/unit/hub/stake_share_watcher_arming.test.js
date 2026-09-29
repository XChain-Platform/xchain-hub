'use strict';

const { expect } = require('chai');
const { armStakeShareWatcher } = require('../../../src/hub/capabilities.js');
const StakeShareWatcher = require('../../../src/validators/stake_share_watcher.js');
const { buildOracleRpc } = require('../../../src/api/rpc/oracle.js');

// A hub with no operator staking sources must not keep a watcher that never
// polls: getstakeshare would answer `active: true` with `passes: 0` and hide
// the missing config.
function fakeHub() {
    return { p2pConfig: {}, network: 'testnet', resolveIndexerUrl: async () => null };
}

// The real watcher, fed an env that names no operator staking sources.
class UnconfiguredWatcher extends StakeShareWatcher {
    constructor(hub) { super(hub, { env: {}, log: () => {} }); }
}

describe('stake-share watcher arming', function () {
    it('drops a watcher that declines to start', function () {
        expect(armStakeShareWatcher(fakeHub(), UnconfiguredWatcher)).to.equal(null);
    });

    it('keeps a watcher that started', function () {
        class StartedWatcher { start() { return true; } stop() {} }
        expect(armStakeShareWatcher(fakeHub(), StartedWatcher)).to.be.an.instanceOf(StartedWatcher);
    });

    it('getstakeshare reads an unconfigured hub as inactive', async function () {
        const hub = fakeHub();
        hub.stakeShareWatcher = armStakeShareWatcher(hub, UnconfiguredWatcher);
        const rpc = buildOracleRpc({ hub });
        expect(await rpc.getstakeshare()).to.deep.equal({ active: false });
    });
});
