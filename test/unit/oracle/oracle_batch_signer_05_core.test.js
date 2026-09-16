'use strict';

const {
    expect,
    OracleBatchSigner,
    OracleConsensus,
    ValidatorIdentity,
    DB_METHODS,
    canonicalBuilder,
    buildCanonical,
    baseRounds,
    clone,
    snapshotRows,
    memDb,
    buildMesh
} = require('./oracle_batch_signer.test.js');

async function captureWarnings(fn) {
        let lines = [];
        let real  = console.warn;
        console.warn = (...a) => lines.push(a.join(' '));
        try { await fn(); } finally { console.warn = real; }
        return lines;
    }

const testCase1 = async function () {
        let mesh = buildMesh(4);
        let leader = mesh.nodes[0];
        // Drop the leader from the capability snapshot at the anchor.
        leader.hub.capabilitySnapshot.getWeightSnapshot = async () => ({
            validators: mesh.pubkeys.slice(1).map((pk, i) => ({ pubkey: pk, weight: '1', source: 'src' + (i + 1) }))
        });

        let res = await leader.signer.collectBatchSignatures(100, 105, 5005, baseRounds());
        mesh.stop();

        expect(res.met).to.equal(false);
        expect(res.sigs).to.have.length(0);
        // Not a timeout: the round never started, so the liveness counter stays clean.
        expect(leader.signer.getStats().batchSignTimeouts).to.equal(0);
    };

function registerSuite1() {
    it('withholds the batch when this hub does not hold `price` at the batch anchor', testCase1);
}

function registerOuterSuite5() {
    registerSuite1();
}

describe('OracleBatchSigner (XPRICEB batch-signing round)', registerOuterSuite5);

