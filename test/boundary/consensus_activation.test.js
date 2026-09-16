// Boundary coverage for the two consensus flag-day gates checkpoint_commitment
// and retraction_signing, registry rows since W5 that every caller judges with
// the registry's own activeAt by literal key. Both gate a change to a SIGNED
// consensus preimage, so the threshold arithmetic and fail-closed handling of
// malformed input decide whether federation quorum verification forks. This
// exercises the edges: exactly at the height, one below, zero/negative,
// non-numeric input, and an unknown network (which must be off, never on).

const assert = require('assert');
const registry = require('../../src/consensus/gate_registry');

const CHECKPOINT_COMMITMENT_KEY = 'checkpoint_commitment_activation.CHECKPOINT_COMMITMENT_ACTIVATION';
const RETRACTION_SIGNING_KEY    = 'retraction_signing_activation.RETRACTION_SIGNING_ACTIVATION';

// The predicate shape the callers use: the row's BTC-anchored snapshot block on
// the height plane, judged for one network.
const predicateFor = (key) => (snapshotBlock, network) => registry.activeAt(key, network, null, snapshotBlock, null);

// Fourth tuple element: the expected testnet threshold. checkpoint_commitment
// arms testnet at 146000 (the SPV root suffix must not be signed before every
// chain is past its STATE_COMMITMENT height, else the hub refuses to sign
// every testnet checkpoint); retraction_signing stays genesis (0).
const cases = [
    ['checkpoint_commitment', predicateFor(CHECKPOINT_COMMITMENT_KEY), registry.get(CHECKPOINT_COMMITMENT_KEY), 146000],
    ['retraction_signing', predicateFor(RETRACTION_SIGNING_KEY), registry.get(RETRACTION_SIGNING_KEY), 0],
];

for (const [name, isActive, MAP, testnetThreshold] of cases) {
    describe(`${name} activation gate (boundary)`, function () {
        const threshold = MAP.mainnet;

        it('is inclusive at exactly the activation height', function () {
            assert.strictEqual(isActive(threshold, 'mainnet'), true);
        });

        it('is off one block below the activation height', function () {
            assert.strictEqual(isActive(threshold - 1, 'mainnet'), false);
        });

        it('regtest is armed from genesis; testnet arms at its own threshold', function () {
            assert.strictEqual(MAP.regtest, 0);
            assert.strictEqual(isActive(0, 'regtest'), true);
            assert.strictEqual(MAP.testnet, testnetThreshold);
            assert.strictEqual(isActive(testnetThreshold, 'testnet'), true);
            // One below the testnet threshold is off. For a genesis-armed map
            // (threshold 0) this probes height -1, which fails closed as a
            // negative height; for checkpoint_commitment it probes 145999.
            assert.strictEqual(isActive(testnetThreshold - 1, 'testnet'), false);
        });

        it('fails closed on non-numeric / NaN input', function () {
            assert.strictEqual(isActive('not-a-number', 'mainnet'), false);
            assert.strictEqual(isActive(NaN, 'mainnet'), false);
            assert.strictEqual(isActive(undefined, 'mainnet'), false);
        });

        it('fails closed on a negative height', function () {
            assert.strictEqual(isActive(-1, 'mainnet'), false);
        });

        it('fails closed (off) on an unknown network', function () {
            assert.strictEqual(isActive(threshold, 'nonsense-net'), false);
        });

        it('parseInt tolerates a trailing-garbage numeric string at/above threshold', function () {
            assert.strictEqual(isActive(String(threshold) + 'abc', 'mainnet'), true);
        });
    });
}
