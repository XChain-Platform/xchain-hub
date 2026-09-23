'use strict';

const { expect } = require('./oracle_publisher_confirmation.test.js');

const OraclePublisher = require('../../../../src/oracle/publisher.js');

// One underpaid batch can strand every batch published after it because the
// publisher spends its own unconfirmed change and miners score a transaction by
// its whole ancestor package. Nine transactions over nine hours left the newest
// paying 1.36 per kB against ancestors paying 0.003.
function pub(cfg) {
        return new OraclePublisher({ p2pConfig: Object.assign({}, cfg || {}), db: null,
                                     getIdentity: () => null, capabilitySnapshot: null });
    }

const testCase1 = function () {
        expect(pub().allowUnconfirmedInputs, 'default must be false').to.equal(false);
    };

const testCase2 = function () {
        expect(pub({ ORACLE_PUBLISH_ALLOW_UNCONFIRMED_INPUTS: 'true' }).allowUnconfirmedInputs,
            'explicit true must opt in').to.equal(true);
        for (const v of ['false', '1', 'yes', '', 'TRUE']) {
            expect(pub({ ORACLE_PUBLISH_ALLOW_UNCONFIRMED_INPUTS: v }).allowUnconfirmedInputs,
                'only the exact string true opts in, got ' + v).to.equal(false);
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
