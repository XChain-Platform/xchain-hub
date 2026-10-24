'use strict';

const assert = require('assert');

const {
    COSIGN_REFUSAL,
    snapshotCosignRefusal
} = require('../../../../src/anchor/snapshot_checkpoint/cosign_policy.js');

const hash = character => character.repeat(64);
const payload = {
    block_hash: hash('a'),
    state_root: hash('b'),
    state_root_version: 2
};
const checkpoint = Object.assign({
    chain: 'BTC',
    network: 'testnet',
    block_index: 100
}, payload);

function request(changes) {
    return {
        snapshot_block: 106,
        cp: Object.assign({}, checkpoint, changes)
    };
}

function view(changes) {
    return Object.assign({
        network: 'testnet',
        gateActive: true,
        expectedBlock: 100,
        committedHeight: 106,
        chainHeight: 106,
        confirmations: 6,
        local: Object.assign({}, payload),
        signed: null,
        stored: null
    }, changes);
}

function result(req, changes) {
    return snapshotCosignRefusal(req, view(changes));
}

describe('snapshot co-sign refusal constants', function () {
    it('exports the frozen refusal vocabulary', function () {
        assert.deepStrictEqual(COSIGN_REFUSAL, {
            MALFORMED: 'malformed',
            GATE_INACTIVE: 'gate_inactive',
            WRONG_BLOCK: 'wrong_block',
            SHALLOW: 'shallow',
            LOCAL_MISMATCH: 'local_mismatch',
            CONFLICTING_PAYLOAD: 'conflicting_payload'
        });
        assert.strictEqual(Object.isFrozen(COSIGN_REFUSAL), true);
    });
});

describe('snapshotCosignRefusal accepted requests', function () {
    it('accepts a matching request at exactly the required depth', function () {
        assert.strictEqual(result(request(), { chainHeight: 106 }), null);
    });

    it('compares hashes without regard to case', function () {
        assert.strictEqual(result(request({
            block_hash: hash('A'),
            state_root: hash('B')
        })), null);
    });

    it('compares the root version numerically', function () {
        assert.strictEqual(result(request({ state_root_version: '2' })), null);
    });

    it('allows the same signed and stored payload to be signed again', function () {
        assert.strictEqual(result(request(), {
            signed: Object.assign({}, payload),
            stored: Object.assign({}, payload)
        }), null);
    });
});

describe('snapshotCosignRefusal malformed requests', function () {
    it('refuses a missing request or checkpoint', function () {
        assert.strictEqual(snapshotCosignRefusal(null, view()), COSIGN_REFUSAL.MALFORMED);
        assert.strictEqual(snapshotCosignRefusal({}, view()), COSIGN_REFUSAL.MALFORMED);
    });

    it('refuses an invalid snapshot block', function () {
        for(const snapshotBlock of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '106']) {
            const req = request();
            req.snapshot_block = snapshotBlock;
            assert.strictEqual(result(req), COSIGN_REFUSAL.MALFORMED);
        }
    });

    it('refuses a chain other than BTC', function () {
        assert.strictEqual(result(request({ chain: 'LTC' })), COSIGN_REFUSAL.MALFORMED);
    });

    it('refuses a network other than the local network', function () {
        assert.strictEqual(result(request({ network: 'mainnet' })), COSIGN_REFUSAL.MALFORMED);
    });

    it('refuses an invalid checkpoint block', function () {
        for(const blockIndex of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '100']) {
            assert.strictEqual(result(request({ block_index: blockIndex })), COSIGN_REFUSAL.MALFORMED);
        }
    });

    it('refuses a malformed block hash', function () {
        for(const blockHash of [null, hash('a').slice(1), hash('a') + '0', hash('z')]) {
            assert.strictEqual(result(request({ block_hash: blockHash })), COSIGN_REFUSAL.MALFORMED);
        }
    });

    it('refuses a malformed state root', function () {
        for(const stateRoot of [null, hash('b').slice(1), hash('b') + '0', hash('z')]) {
            assert.strictEqual(result(request({ state_root: stateRoot })), COSIGN_REFUSAL.MALFORMED);
        }
    });
});

describe('snapshotCosignRefusal policy ordering', function () {
    it('refuses an inactive gate before checking the expected block', function () {
        assert.strictEqual(result(request({ block_index: 99 }), {
            gateActive: false
        }), COSIGN_REFUSAL.GATE_INACTIVE);
    });

    it('refuses the wrong checkpoint block before checking depth', function () {
        assert.strictEqual(result(request({ block_index: 99 }), {
            chainHeight: 0
        }), COSIGN_REFUSAL.WRONG_BLOCK);
    });

    it('refuses a shallow checkpoint before checking the local payload', function () {
        assert.strictEqual(result(request(), {
            chainHeight: 105,
            local: null
        }), COSIGN_REFUSAL.SHALLOW);
    });

    it('refuses committed height one block below required depth before local reads', function () {
        assert.strictEqual(result(request(), {
            committedHeight: 105,
            chainHeight: 1000,
            local: null
        }), COSIGN_REFUSAL.SHALLOW);
    });

    it('refuses a local mismatch before checking prior payloads', function () {
        assert.strictEqual(result(request(), {
            local: null,
            signed: Object.assign({}, payload, { state_root: hash('c') })
        }), COSIGN_REFUSAL.LOCAL_MISMATCH);
    });
});

describe('snapshotCosignRefusal local payload checks', function () {
    it('refuses a missing local payload', function () {
        assert.strictEqual(result(request(), { local: null }), COSIGN_REFUSAL.LOCAL_MISMATCH);
    });

    it('refuses a different local block hash', function () {
        assert.strictEqual(result(request(), {
            local: Object.assign({}, payload, { block_hash: hash('c') })
        }), COSIGN_REFUSAL.LOCAL_MISMATCH);
    });

    it('refuses a different local state root', function () {
        assert.strictEqual(result(request(), {
            local: Object.assign({}, payload, { state_root: hash('c') })
        }), COSIGN_REFUSAL.LOCAL_MISMATCH);
    });

    it('refuses a different local state root version', function () {
        assert.strictEqual(result(request(), {
            local: Object.assign({}, payload, { state_root_version: 1 })
        }), COSIGN_REFUSAL.LOCAL_MISMATCH);
    });
});

describe('snapshotCosignRefusal prior payload checks', function () {
    it('refuses a conflicting signed payload', function () {
        assert.strictEqual(result(request(), {
            signed: Object.assign({}, payload, { state_root: hash('c') })
        }), COSIGN_REFUSAL.CONFLICTING_PAYLOAD);
    });

    it('refuses a conflicting stored payload', function () {
        assert.strictEqual(result(request(), {
            stored: Object.assign({}, payload, { block_hash: hash('c') })
        }), COSIGN_REFUSAL.CONFLICTING_PAYLOAD);
    });

    it('uses the same hash and version comparison for prior payloads', function () {
        const same = {
            block_hash: hash('A'),
            state_root: hash('B'),
            state_root_version: '2'
        };
        assert.strictEqual(result(request(), { signed: same, stored: same }), null);
        assert.strictEqual(result(request(), {
            stored: Object.assign({}, payload, { state_root_version: 3 })
        }), COSIGN_REFUSAL.CONFLICTING_PAYLOAD);
    });
});
