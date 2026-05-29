'use strict';

const sinon        = require('sinon');
const { expect }   = require('chai');
const proxyquire   = require('proxyquire');

describe('CapabilitySnapshot', function () {

    let axiosStub, CapabilitySnapshot;

    beforeEach(function () {
        axiosStub = { post: sinon.stub() };
        CapabilitySnapshot = proxyquire('../../src/CapabilitySnapshot', { axios: axiosStub });
    });

    afterEach(function () {
        sinon.restore();
    });

    // Fake hub: resolves an indexer URL and (optionally) exposes a registry that
    // serves the authoritative MIN_STAKE for a capability.
    function makeHub(registry) {
        return {
            capabilityRegistry: registry,
            _resolveBtcIndexerUrl: async () => 'http://indexer.local/rpc'
        };
    }

    function okResult() {
        return { data: { result: { capability: 'attestation', block_index: 100, count: 1, validators: [{ pubkey: 'ab', amount: '50000' }] } } };
    }

    describe('getSnapshot()', function () {

        it('passes the hub registry MIN_STAKE as min_stake in the RPC payload', async function () {
            axiosStub.post.resolves(okResult());
            let registry = { getMinStake: sinon.stub().returns('25000') };
            let snap = new CapabilitySnapshot(makeHub(registry));

            await snap.getSnapshot('attestation', 100);

            expect(axiosStub.post.calledOnce).to.equal(true);
            let body = axiosStub.post.firstCall.args[1];
            expect(body.method).to.equal('getcapabilityvalidators');
            expect(body.params.capability).to.equal('attestation');
            expect(body.params.block_index).to.equal(100);
            // The whole point of the fix: the hub's threshold rides along so the
            // indexer's local config can't be the divergence point.
            expect(body.params.min_stake).to.equal('25000');
            expect(registry.getMinStake.calledWith('attestation')).to.equal(true);
        });

        it('coerces a numeric MIN_STAKE to a string', async function () {
            axiosStub.post.resolves(okResult());
            let registry = { getMinStake: sinon.stub().returns(25000) };
            let snap = new CapabilitySnapshot(makeHub(registry));

            await snap.getSnapshot('attestation', 100);

            expect(axiosStub.post.firstCall.args[1].params.min_stake).to.equal('25000');
        });

        it('omits min_stake when the registry is not ready (pre-startCapabilities)', async function () {
            axiosStub.post.resolves(okResult());
            let snap = new CapabilitySnapshot(makeHub(null));

            await snap.getSnapshot('attestation', 100);

            let body = axiosStub.post.firstCall.args[1];
            expect(Object.prototype.hasOwnProperty.call(body.params, 'min_stake')).to.equal(false);
        });

        it('omits min_stake when the registry has no threshold for the capability', async function () {
            axiosStub.post.resolves(okResult());
            let registry = { getMinStake: sinon.stub().returns(null) };
            let snap = new CapabilitySnapshot(makeHub(registry));

            await snap.getSnapshot('attestation', 100);

            let body = axiosStub.post.firstCall.args[1];
            expect(Object.prototype.hasOwnProperty.call(body.params, 'min_stake')).to.equal(false);
        });
    });
});
