// Boundary coverage for the two consensus flag-day gates
// checkpoint_commitment_activation.js and
// retraction_signing_activation.js. Both gate a change to a SIGNED consensus
// preimage, so their threshold arithmetic and fail-closed handling of
// malformed input decide whether federation quorum verification forks. This
// exercises the edges: exactly at the height, one below, zero/negative,
// non-numeric input, and an unknown network (which must be off, never on).

const assert = require('assert');
const {
    CHECKPOINT_COMMITMENT_ACTIVATION, isCheckpointCommitmentActive,
} = require('../../src/checkpoint_commitment_activation.js');
const {
    RETRACTION_SIGNING_ACTIVATION, isRetractionSigningActive,
} = require('../../src/retraction_signing_activation.js');

// Fourth tuple element: the expected testnet threshold. checkpoint_commitment
// arms testnet at 146000 (the SPV root suffix must not be signed before every
// chain is past its STATE_COMMITMENT height, else the hub refuses to sign
// every testnet checkpoint); retraction_signing stays genesis (0).
const cases = [
    ['checkpoint_commitment', isCheckpointCommitmentActive, CHECKPOINT_COMMITMENT_ACTIVATION, 146000],
    ['retraction_signing', isRetractionSigningActive, RETRACTION_SIGNING_ACTIVATION, 0],
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
