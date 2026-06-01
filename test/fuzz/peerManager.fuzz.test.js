'use strict';

const sinon        = require('sinon');
const { expect }   = require('chai');
const fc           = require('fast-check');
const EventEmitter = require('events');
const gen          = require('./generators');

// PeerManager is constructed directly — we need to mock its dependencies
// but call _handleInbound, _buildEnvelope, _makeId directly.
const PeerManager = require('../../src/PeerManager');

const SELF_ADDR = 'ws://self-validator:10001';

describe('Fuzz: PeerManager', function () {

    let pm, dbStub;

    beforeEach(function () {
        dbStub = { doQuery: sinon.stub().resolves([]) };
        pm = new PeerManager({
            P2P_VALIDATOR_ADDR:  SELF_ADDR,
            REQUIRE_SIGNATURES:  false,
            P2P_MSG_DEDUP_TTL:   60000,
            P2P_MAX_PAYLOAD:     1048576,
            P2P_PORT:            19999,
            P2P_HOST:            '127.0.0.1'
        }, dbStub);
        // Initialize the internal structures that _handleInbound uses
        pm.validatorAddr = SELF_ADDR;
        pm.seenIds = new Map();
        pm.peers = new Map();
    });

    afterEach(function () {
        pm.removeAllListeners();
        sinon.restore();
    });

    function mockWs() {
        return {
            _peerAddr:  null,
            readyState: 1, // WebSocket.OPEN
            close:      sinon.stub(),
            send:       sinon.stub()
        };
    }

    // -----------------------------------------------------------------
    // _handleInbound() — structural robustness
    // -----------------------------------------------------------------

    describe('_handleInbound() robustness', function () {

        it('arbitrary JSON objects never crash _handleInbound', function () {
            // _handleInbound does JSON.parse then accesses envelope.type etc.
            // JSON.parse("null") → null, and null.type throws. This tests that
            // object-shaped JSON never crashes (non-object JSON is handled by
            // the non-JSON test below via the catch in JSON.parse).
            fc.assert(fc.property(
                fc.oneof(
                    fc.record({}),
                    fc.dictionary(
                        fc.string({ minLength: 1, maxLength: 10 }),
                        fc.oneof(fc.string({ maxLength: 20 }), fc.integer(), fc.boolean(), fc.constant(null))
                    ),
                    fc.record({
                        type:      fc.oneof(fc.string({ maxLength: 20 }), fc.integer(), fc.constant(null)),
                        id:        fc.oneof(fc.string({ maxLength: 20 }), fc.integer(), fc.constant(null)),
                        sender:    fc.oneof(fc.string({ maxLength: 30 }), fc.integer(), fc.constant(null)),
                        timestamp: fc.oneof(fc.integer(), fc.string({ maxLength: 10 }), fc.constant(null)),
                        data:      fc.anything({ maxDepth: 2 })
                    })
                ),
                function (payload) {
                    let ws = mockWs();
                    expect(function () { pm._handleInbound(ws, JSON.stringify(payload), null); }).to.not.throw();
                }
            ), { numRuns: 300 });
        });

        it('non-JSON strings never crash _handleInbound', function () {
            fc.assert(fc.property(
                fc.string({ minLength: 0, maxLength: 500 }),
                function (raw) {
                    let ws = mockWs();
                    expect(function () { pm._handleInbound(ws, raw, null); }).to.not.throw();
                }
            ), { numRuns: 300 });
        });

        it('malformed envelopes are always silently dropped (no message emitted)', function () {
            // Note: _handleInbound does JSON.parse then accesses envelope.type.
            // If JSON.parse produces null, number, string, or array, envelope.type
            // throws TypeError. This is a real bug: the try/catch only covers
            // JSON.parse, not the field access. We filter to only test object-shaped
            // malformed envelopes; the non-object case is documented below.
            let objectMalformed = fc.oneof(
                fc.constant({}),
                fc.constant({ type: 123, id: 'abc', sender: 'x', timestamp: 1 }),
                fc.constant({ type: 'T', id: 123, sender: 'x', timestamp: 1 }),
                fc.constant({ type: 'T', id: 'abc', timestamp: 1 }),
                fc.constant({ type: 'T', id: 'abc', sender: 'x', timestamp: 'bad' }),
                fc.constant({ type: '', id: 'abc', sender: 'x', timestamp: 1 }),
                fc.constant({ type: 'T', id: '', sender: 'x', timestamp: 1 }),
                fc.constant({ type: 'T', id: 'abc', sender: '', timestamp: 1 }),
                fc.constant([1, 2, 3])  // Array: envelope.type returns undefined → early return
            );

            fc.assert(fc.property(objectMalformed, function (badEnvelope) {
                let ws = mockWs();
                let raw = JSON.stringify(badEnvelope);
                let emitted = 0;
                pm.on('message', function () { emitted++; });
                pm._handleInbound(ws, raw, null);
                expect(emitted).to.equal(0);
                pm.removeAllListeners('message');
            }), { numRuns: 100 });
        });

        it('non-object JSON values (null, number, string, boolean) are silently dropped', function () {
            let nonObjectJson = fc.oneof(
                fc.constant('null'),
                fc.constant('42'),
                fc.constant('"hello"'),
                fc.constant('true'),
                fc.constant('false')
            );
            fc.assert(fc.property(nonObjectJson, function (raw) {
                let ws = mockWs();
                let emitted = 0;
                pm.on('message', function () { emitted++; });
                expect(function () { pm._handleInbound(ws, raw, null); }).to.not.throw();
                expect(emitted).to.equal(0);
                pm.removeAllListeners('message');
            }), { numRuns: 10 });
        });

        it('valid envelope from non-self sender is emitted exactly once', function () {
            fc.assert(fc.property(gen.fc_p2pEnvelope(SELF_ADDR), function (envelope) {
                // Reset dedup for each property run
                pm.seenIds.clear();
                let ws = mockWs();
                ws._peerAddr = envelope.sender;
                // Register the peer so lastSeen update doesn't fail
                pm.peers.set(envelope.sender, { ws: ws, state: 'open', lastSeen: 0 });

                let emitted = 0;
                pm.on('message', function () { emitted++; });
                pm._handleInbound(ws, JSON.stringify(envelope), envelope.sender);
                expect(emitted).to.equal(1);
                pm.removeAllListeners('message');
            }), { numRuns: 200 });
        });

        it('duplicate message IDs are always deduplicated', function () {
            fc.assert(fc.property(gen.fc_p2pEnvelope(SELF_ADDR), function (envelope) {
                pm.seenIds.clear();
                let ws = mockWs();
                ws._peerAddr = envelope.sender;
                pm.peers.set(envelope.sender, { ws: ws, state: 'open', lastSeen: 0 });

                let raw = JSON.stringify(envelope);
                let emitted = 0;
                pm.on('message', function () { emitted++; });

                pm._handleInbound(ws, raw, envelope.sender);
                pm._handleInbound(ws, raw, envelope.sender);
                pm._handleInbound(ws, raw, envelope.sender);

                expect(emitted).to.equal(1);
                pm.removeAllListeners('message');
            }), { numRuns: 200 });
        });

        it('envelope from self address is never emitted', function () {
            fc.assert(fc.property(
                fc.string({ unit: fc.constantFrom('A','B','C','_'), minLength: 3, maxLength: 15 }),
                fc.string({ unit: fc.constantFrom('a','b','1','2','-'), minLength: 5, maxLength: 20 }),
                function (type, id) {
                    pm.seenIds.clear();
                    let ws = mockWs();
                    ws._peerAddr = null;
                    let selfEnvelope = {
                        type:      type,
                        id:        id,
                        sender:    SELF_ADDR,
                        timestamp: Date.now(),
                        data:      {}
                    };

                    let emitted = 0;
                    pm.on('message', function () { emitted++; });
                    pm._handleInbound(ws, JSON.stringify(selfEnvelope), null);
                    expect(emitted).to.equal(0);
                    pm.removeAllListeners('message');
                }
            ), { numRuns: 100 });
        });

        it('seenIds map grows by exactly the count of unique message IDs', function () {
            fc.assert(fc.property(
                fc.array(gen.fc_p2pEnvelope(SELF_ADDR), { minLength: 1, maxLength: 10 }),
                function (envelopes) {
                    pm.seenIds.clear();
                    let uniqueIds = new Set(envelopes.map(e => e.id));

                    for (let e of envelopes) {
                        let ws = mockWs();
                        ws._peerAddr = e.sender;
                        pm.peers.set(e.sender, { ws: ws, state: 'open', lastSeen: 0 });
                        pm._handleInbound(ws, JSON.stringify(e), e.sender);
                    }

                    expect(pm.seenIds.size).to.equal(uniqueIds.size);
                    pm.removeAllListeners();
                }
            ), { numRuns: 100 });
        });
    });

    // -----------------------------------------------------------------
    // _buildEnvelope()
    // -----------------------------------------------------------------

    describe('_buildEnvelope()', function () {

        it('all required fields are always present and correctly typed', function () {
            fc.assert(fc.property(
                fc.string({ minLength: 1, maxLength: 20 }),
                fc.record({ key: fc.string({ maxLength: 10 }) }),
                function (type, data) {
                    let env = pm._buildEnvelope(type, data);
                    expect(env).to.have.property('type', type);
                    expect(env).to.have.property('id').that.is.a('string').and.not.empty;
                    expect(env).to.have.property('sender', SELF_ADDR);
                    expect(env).to.have.property('timestamp').that.is.a('number');
                    expect(env).to.have.property('data');
                }
            ), { numRuns: 200 });
        });
    });

    // -----------------------------------------------------------------
    // _makeId()
    // -----------------------------------------------------------------

    describe('_makeId()', function () {

        it('generated IDs are globally unique across rapid successive calls', function () {
            fc.assert(fc.property(fc.integer({ min: 2, max: 100 }), function (count) {
                let ids = Array.from({ length: count }, function () { return pm._makeId(); });
                expect(new Set(ids).size).to.equal(ids.length);
            }), { numRuns: 50 });
        });
    });
});
