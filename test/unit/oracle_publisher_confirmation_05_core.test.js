'use strict';

const {
    fs,
    os,
    path,
    sinon,
    expect,
    waitUntil,
    ME,
    ADDR,
    utxo,
    makeEncoder,
    queueEntry,
    makePublisher,
    seedQueue,
    readJsonl,
    cleanupPublisherConfirmation
} = require('./oracle_publisher_confirmation.test.js');

const OraclePublisher = require('../../src/oracle/publisher.js');

// One underpaid batch can strand every batch published after it because the
// publisher spends its own unconfirmed change and miners score a transaction by
// its whole ancestor package. Nine transactions over nine hours left the newest
// paying 1.36 per kB against ancestors paying 0.003.
function pub(cfg) {
        return new OraclePublisher({ p2pConfig: Object.assign({}, cfg || {}), db: null,
                                     getIdentity: () => null, capabilitySnapshot: null });
    }

const testCase1 = function () {
        if (pub().allowUnconfirmedInputs !== false) throw new Error('default must be false');
    };

const testCase2 = function () {
        if (pub({ ORACLE_PUBLISH_ALLOW_UNCONFIRMED_INPUTS: 'true' }).allowUnconfirmedInputs !== true) {
            throw new Error('explicit true must opt in');
        }
        for (const v of ['false', '1', 'yes', '', 'TRUE']) {
            if (pub({ ORACLE_PUBLISH_ALLOW_UNCONFIRMED_INPUTS: v }).allowUnconfirmedInputs !== false) {
                throw new Error('only the exact string true opts in, got ' + v);
            }
        }
    };

function registerSuite1() {
    it('refuses unconfirmed inputs by default', testCase1);
    it('allows them only when a deployment explicitly opts in', testCase2);
}

function registerOuterSuite5() {
    registerSuite1();
}

describe('OraclePublisher confirmed-input policy @regression', registerOuterSuite5);
