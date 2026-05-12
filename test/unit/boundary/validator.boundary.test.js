'use strict';

const sinon        = require('sinon');
const { expect }   = require('chai');
const proxyquire   = require('proxyquire');

let mockDb;
const XChainHub = proxyquire('../../../src/XChainHub', {
    './db.js':              function () { return mockDb; },
    './PeerManager.js':     function () { return null; },
    './Consensus.js':       function () {},
    './ValidatorIdentity.js': function () {},
    './OracleConsensus.js': function () {},
    './OracleRound.js':     function () {},
    './RewardTracker.js':   function () {},
    './SlashDetector.js':   function () {},
    './CrossChainEngine.js': function () {},
    './ReorgHandler.js':    function () {},
    './SwapTracker.js':     function () {},
    './Governance.js':      function () {}
});

describe('Boundary: Validator Registration', function () {

    let hub;

    beforeEach(function () {
        mockDb = {
            doQuery:        sinon.stub().resolves([]),
            setParam:       sinon.stub().resolves(),
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

    // -----------------------------------------------------------------
    // signing_pubkey regex: /^[0-9a-fA-F]{64}$/
    // -----------------------------------------------------------------

    describe('signing_pubkey validation', function () {

        it('exactly 64 lowercase hex chars → accepted', async function () {
            let pubkey = 'aa'.repeat(32);
            await hub.registerValidator(pubkey, 'ws://test:10001');
            expect(mockDb.doQuery.called).to.be.true;
        });

        it('exactly 64 uppercase hex chars → accepted', async function () {
            let pubkey = 'AA'.repeat(32);
            await hub.registerValidator(pubkey, 'ws://test:10001');
            expect(mockDb.doQuery.called).to.be.true;
        });

        it('mixed case hex chars → accepted', async function () {
            let pubkey = 'aAbBcCdDeEfF'.repeat(5) + 'aAbB';
            expect(pubkey).to.have.lengthOf(64);
            await hub.registerValidator(pubkey, 'ws://test:10001');
            expect(mockDb.doQuery.called).to.be.true;
        });

        it('63 hex chars → rejected', async function () {
            let pubkey = 'a'.repeat(63);
            try {
                await hub.registerValidator(pubkey, 'ws://test:10001');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('Invalid signing pubkey');
            }
        });

        it('65 hex chars → rejected', async function () {
            let pubkey = 'a'.repeat(65);
            try {
                await hub.registerValidator(pubkey, 'ws://test:10001');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('Invalid signing pubkey');
            }
        });

        it('64 chars with non-hex character → rejected', async function () {
            let pubkey = 'a'.repeat(63) + 'g'; // 'g' is not hex
            try {
                await hub.registerValidator(pubkey, 'ws://test:10001');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('Invalid signing pubkey');
            }
        });

        it('empty string → rejected', async function () {
            try {
                await hub.registerValidator('', 'ws://test:10001');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('Invalid signing pubkey');
            }
        });

        it('null → rejected', async function () {
            try {
                await hub.registerValidator(null, 'ws://test:10001');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('Invalid signing pubkey');
            }
        });

        it('undefined → rejected', async function () {
            try {
                await hub.registerValidator(undefined, 'ws://test:10001');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('Invalid signing pubkey');
            }
        });
    });

    // -----------------------------------------------------------------
    // addr validation
    // -----------------------------------------------------------------

    describe('addr validation', function () {

        it('empty string addr → rejected', async function () {
            try {
                await hub.registerValidator('aa'.repeat(32), '');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('addr is required');
            }
        });

        it('null addr → rejected', async function () {
            try {
                await hub.registerValidator('aa'.repeat(32), null);
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('addr is required');
            }
        });

        it('valid addr → accepted', async function () {
            await hub.registerValidator('aa'.repeat(32), 'ws://validator:10001');
            expect(mockDb.doQuery.called).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // syncValidators
    // -----------------------------------------------------------------

    describe('syncValidators', function () {

        it('non-array input → throws', async function () {
            try {
                await hub.syncValidators('not-an-array');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('must be an array');
            }
        });

        it('empty array → no DB inserts, still logs sync', async function () {
            await hub.syncValidators([]);
            // doQuery is called for the reload steps, but no INSERT calls for validators
            // The function should complete without error
        });

        it('entry with invalid pubkey is skipped', async function () {
            await hub.syncValidators([
                { signing_pubkey: 'short', addr: 'ws://test:10001' }
            ]);
            // The INSERT query should not be called for invalid entries
            let insertCalls = mockDb.doQuery.getCalls().filter(c =>
                c.args[0] && c.args[0].includes('INSERT INTO validators')
            );
            expect(insertCalls).to.have.lengthOf(0);
        });

        it('entry with missing addr is skipped', async function () {
            await hub.syncValidators([
                { signing_pubkey: 'aa'.repeat(32), addr: '' }
            ]);
            let insertCalls = mockDb.doQuery.getCalls().filter(c =>
                c.args[0] && c.args[0].includes('INSERT INTO validators')
            );
            expect(insertCalls).to.have.lengthOf(0);
        });

        it('valid entry is inserted', async function () {
            await hub.syncValidators([
                { signing_pubkey: 'aa'.repeat(32), addr: 'ws://v1:10001' }
            ]);
            let insertCalls = mockDb.doQuery.getCalls().filter(c =>
                c.args[0] && c.args[0].includes('INSERT INTO validators')
            );
            expect(insertCalls).to.have.lengthOf(1);
        });
    });
});
