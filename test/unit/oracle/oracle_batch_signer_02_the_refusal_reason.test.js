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

// ─────────────────────────────── the refusal has to be readable

// Capture the refusal lines without pulling sinon into a file that has never
// needed it. Restores in a finally so a throwing assertion cannot leave the
// console patched for the rest of the suite.
async function captureWarnings(fn) {
        let lines = [];
        let real  = console.warn;
        console.warn = (...a) => lines.push(a.join(' '));
        try { await fn(); } finally { console.warn = real; }
        return lines;
    }

// The line an operator actually got for the two windows that never published
// was "proposal does not match this hub's own finalized rounds" and nothing
// else, and the leader's proposal is persisted nowhere, so the disagreement
// could not be reconstructed afterwards.
const testCase1 = async function () {
            let mesh = buildMesh(4);
            let fabricated = clone(baseRounds());
            fabricated[3].pairs[0].price = '99999';

            let warns = await captureWarnings(() =>
                mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, fabricated));
            mesh.stop();

            let refusals = warns.filter(l => /refusing to co-sign batch \[100,105\]/.test(l));
            expect(refusals).to.have.length(3);
            for (let line of refusals) {
                expect(line).to.match(/does not match this hub's own finalized rounds/);
                expect(line).to.match(/round 103 pair BTC\/USD price proposed 99999, derived 60003/);
            }
        };

const testCase2 = async function () {
            let mesh = buildMesh(4);
            let shifted = clone(baseRounds());
            shifted[2].timestamp = shifted[2].timestamp + 600;

            let warns = await captureWarnings(() =>
                mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, shifted));
            mesh.stop();

            let refusals = warns.filter(l => /refusing to co-sign/.test(l));
            expect(refusals).to.have.length(3);
            expect(refusals[0]).to.match(/round 102 timestamp proposed 1700001800, derived 1700001200/);
        };

const testCase3 = async function () {
            let mesh = buildMesh(4);
            let extra = clone(baseRounds());
            extra.push({ round: 106, timestamp: 1700003600, btcBlockHeight: 5006,
                         pairs: [{ pair: 'BTC/USD', price: '60006' }] });

            let warns = await captureWarnings(() =>
                mesh.nodes[0].signer.collectBatchSignatures(100, 106, 5006, extra));
            mesh.stop();

            let refusals = warns.filter(l => /refusing to co-sign/.test(l));
            expect(refusals).to.have.length(3);
            expect(refusals[0]).to.match(/round\(s\) 106 proposed but not finalized here/);
        };

const testCase4 = async function () {
            let mesh = buildMesh(4);
            let short = clone(baseRounds()).filter(r => r.round !== 102);

            let warns = await captureWarnings(() =>
                mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, short));
            mesh.stop();

            let refusals = warns.filter(l => /refusing to co-sign/.test(l));
            expect(refusals).to.have.length(3);
            expect(refusals[0]).to.match(/round\(s\) 102 finalized here but not proposed/);
        };

// Diagnostics may never move the verdict: the canonical byte comparison is
// still the only thing that decides, and an honest window must stay signable.
const testCase5 = async function () {
            let mesh = buildMesh(4);
            let warns = await captureWarnings(async () => {
                let res = await mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, baseRounds());
                expect(res.met).to.equal(true);
            });
            mesh.stop();
            expect(warns.filter(l => /refusing to co-sign/.test(l))).to.have.length(0);
        };

function registerSuite1() {
    it('names the first differing round and the differing PRICE', testCase1);
    it('names a differing round TIMESTAMP', testCase2);
    it('names a round the leader proposed that never finalized here', testCase3);
    it('names a round finalized here that the proposal omits', testCase4);
    it('changes no verdict: the honest window still reaches quorum in silence', testCase5);
}

function registerOuterSuite2() {
    describe('the refusal reason', registerSuite1);
}

describe('OracleBatchSigner (XPRICEB batch-signing round)', registerOuterSuite2);
