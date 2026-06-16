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

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

let mockDb;
const DatabaseStub = function() { return mockDb; };

const XChainHub = proxyquire('../../../src/XChainHub', {
    './db.js':               DatabaseStub,
    './PeerManager.js':      function() { return null; },
    './Consensus.js':        function() {},
    './ValidatorIdentity.js':function() {},
    './OracleConsensus.js':  function() {},
    './OracleRound.js':      function() {},
    './RewardTracker.js':    function() {},
    './SlashDetector.js':    function() {},
    './CrossChainEngine.js': function() {},
    './ReorgHandler.js':     function() {},
    './SwapTracker.js':      function() {},
    './Governance.js':       function() {}
});

// applyConfig batches every collected param into a single db.setParams(rows)
// call (rows are {coin, network, module, paramName, paramValue}); it does not
// call setParams at all when no recognized params are present. These helpers
// read the batched rows so the boundary assertions stay value-focused.
function batchedRows() {
    if (!mockDb.setParams.called) return [];
    return mockDb.setParams.getCall(0).args[0];
}
function paramNamesWritten() {
    return batchedRows().map(r => r.paramName);
}

describe('Boundary: Config Management', function () {

    let hub;

    beforeEach(function () {
        mockDb = {
            setParams:      sinon.stub().resolves(0),
            getAllConfigs:   sinon.stub().resolves({}),
            doQuery:        sinon.stub().resolves([]),
            createDatabase: sinon.stub().resolves(),
            verifyTables:   sinon.stub().resolves(),
            close:          sinon.stub().resolves()
        };
        hub = new XChainHub('host', 3306, 'test_db', 'user', 'pass');
        hub.db = mockDb;
    });

    afterEach(function () {
        sinon.restore();
    });

    // -----------------------------------------------------------------------
    // applyConfig — boundary tests
    // -----------------------------------------------------------------------

    describe('applyConfig()', function () {

        it('skips a coin key that is an empty string', async function () {
            const json = {
                '': { mainnet: { decoder: { host: 'localhost' } } }
            };
            await hub.applyConfig(json);
            expect(mockDb.setParams.called).to.be.false;
        });

        it('batches one row per known parameter present in the module', async function () {
            const json = {
                BTC: {
                    mainnet: {
                        decoder: {
                            host:         'localhost',
                            port:         8332,
                            service_port: 3001,
                            db_host:      '127.0.0.1',
                            db_port:      3306,
                            name:         'decoder_db',
                            user:         'root',
                            pass:         'secret'
                        }
                    }
                }
            };
            await hub.applyConfig(json);
            expect(mockDb.setParams.calledOnce).to.be.true;
            const rows = batchedRows();
            expect(rows).to.have.length(8);
            // Spot-check first and last rows (PARAMETER_LIST order; non-string
            // values are coerced to strings before batching)
            expect(rows[0]).to.deep.equal({ coin: 'BTC', network: 'mainnet', module: 'decoder', paramName: 'host', paramValue: 'localhost' });
            expect(rows[rows.length - 1]).to.deep.equal({ coin: 'BTC', network: 'mainnet', module: 'decoder', paramName: 'pass', paramValue: 'secret' });
        });

        it('silently ignores unknown parameter names not in the allowlist', async function () {
            const json = {
                BTC: {
                    mainnet: {
                        decoder: {
                            host:    'localhost',
                            unknown: 'should-be-ignored',
                            extra:   42
                        }
                    }
                }
            };
            await hub.applyConfig(json);
            // Only 'host' is in PARAMETER_LIST
            const rows = batchedRows();
            expect(rows).to.have.length(1);
            expect(rows[0].paramName).to.equal('host');
        });

        it('skips parameters whose value is null', async function () {
            const json = {
                BTC: {
                    mainnet: {
                        decoder: { host: null, port: 8332 }
                    }
                }
            };
            await hub.applyConfig(json);
            // null host skipped, port written (coerced to string)
            const rows = batchedRows();
            expect(rows).to.have.length(1);
            expect(rows[0].paramName).to.equal('port');
            expect(rows[0].paramValue).to.equal('8332');
        });

        it('skips parameters whose value is undefined', async function () {
            const json = {
                BTC: {
                    mainnet: {
                        decoder: { host: undefined, port: 8332 }
                    }
                }
            };
            await hub.applyConfig(json);
            // undefined host skipped, port written
            const rows = batchedRows();
            expect(rows).to.have.length(1);
            expect(rows[0].paramName).to.equal('port');
        });

        it('does NOT skip a parameter whose value is an empty string', async function () {
            const json = {
                BTC: {
                    mainnet: {
                        decoder: { host: '' }
                    }
                }
            };
            await hub.applyConfig(json);
            const rows = batchedRows();
            expect(rows).to.have.length(1);
            expect(rows[0].paramValue).to.equal('');
        });

        it('makes no DB write for an empty config object', async function () {
            await hub.applyConfig({});
            expect(mockDb.setParams.called).to.be.false;
        });

        it('handles multiple coins, networks, and modules and produces the correct total row count', async function () {
            // 2 coins × 2 networks × 2 modules × 2 params each = 16 rows
            const json = {
                BTC: {
                    mainnet: {
                        decoder:  { host: 'h1', port: 8332 },
                        indexer:  { host: 'h2', port: 8333 }
                    },
                    testnet: {
                        decoder:  { host: 'h3', port: 18332 },
                        indexer:  { host: 'h4', port: 18333 }
                    }
                },
                LTC: {
                    mainnet: {
                        decoder:  { host: 'h5', port: 9332 },
                        indexer:  { host: 'h6', port: 9333 }
                    },
                    testnet: {
                        decoder:  { host: 'h7', port: 19332 },
                        indexer:  { host: 'h8', port: 19333 }
                    }
                }
            };
            await hub.applyConfig(json);
            expect(mockDb.setParams.calledOnce).to.be.true;
            expect(batchedRows()).to.have.length(16);
        });

        it('only writes params that are present when a module has a partial parameter set', async function () {
            const json = {
                DOGE: {
                    mainnet: {
                        explorer: { name: 'doge_explorer', db_host: '10.0.0.1' }
                    }
                }
            };
            await hub.applyConfig(json);
            // PARAMETER_LIST order: host, port, service_port, db_host, db_port, name, user, pass
            // So db_host comes before name
            expect(paramNamesWritten()).to.deep.equal(['db_host', 'name']);
        });

    });

    // -----------------------------------------------------------------------
    // addParametersFromJson — boundary tests
    // -----------------------------------------------------------------------

    describe('addParametersFromJson()', function () {

        it('calls applyConfig directly when no consensus instance is active', async function () {
            hub.consensus = null;
            const json = { BTC: { mainnet: { decoder: { host: 'localhost' } } } };
            const result = await hub.addParametersFromJson(json);
            expect(result).to.equal(true);
            expect(mockDb.setParams.calledOnce).to.be.true;
            expect(batchedRows()).to.have.length(1);
        });

        it('delegates to consensus.propose and skips applyConfig when consensus is active', async function () {
            const proposeSpy = sinon.stub().resolves();
            hub.consensus = { propose: proposeSpy };
            const json = { BTC: { mainnet: { decoder: { host: 'localhost' } } } };
            const result = await hub.addParametersFromJson(json);
            expect(result).to.equal(true);
            expect(proposeSpy.calledOnce).to.be.true;
            expect(proposeSpy.firstCall.args[0]).to.deep.equal(json);
            expect(mockDb.setParams.called).to.be.false;
        });

        it('returns true for an empty config object', async function () {
            hub.consensus = null;
            const result = await hub.addParametersFromJson({});
            expect(result).to.equal(true);
            expect(mockDb.setParams.called).to.be.false;
        });

    });

});
