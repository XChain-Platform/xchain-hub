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

// The second half of the refusal-readability fix. PriceAggregator.receiveBatch pins reference_block
// to the LANDING chain's block_index, so a round ingested from a batch that
// already landed does not carry its own BTC anchor. Reading that column as an
// anchor invents a number (testnet round 116 held DOGE height 67856096 where its
// BTC anchor was 150176) and the refusal that followed said nothing about why.
const testCase1 = async function () {
        let ingested = baseRounds().map(r => (r.round === 102
            ? Object.assign({}, r, { batchSourced: true, btcBlockHeight: 67856096 })
            : r));
        let mesh = buildMesh(4, { perNodeRounds: (i) => (i === 0 ? baseRounds() : ingested) });

        let warns = await captureWarnings(() =>
            mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, baseRounds()));
        mesh.stop();

        let refusals = warns.filter(l => /refusing to co-sign batch \[100,105\]/.test(l));
        expect(refusals).to.have.length(3);
        for (let line of refusals) {
            expect(line).to.match(/round\(s\) 102 here came from a batch that already landed/);
            expect(line).to.match(/this window has already published/);
            // The bare mismatch line must NOT be what an operator sees for this case.
            expect(line).to.not.match(/does not match this hub's own finalized rounds/);
        }
        for (let i = 1; i < mesh.nodes.length; i++) {
            expect(mesh.nodes[i].signer.getStats().batchSignRefusals).to.equal(1);
            expect(mesh.nodes[i].sent).to.have.length(0);
        }
    };

const testCase2 = async function () {
        let mesh = buildMesh(4);
        let res = await mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, baseRounds());
        mesh.stop();
        expect(res.met).to.equal(true);
        expect(res.sigs.length).to.be.at.least(3);
    };

function registerSuite1() {
    it('refuses a window holding a round ingested from a landed batch, and says the window already published', testCase1);
    it('still co-signs a window whose rounds all carry an ordinary v0 proof', testCase2);
}

function registerOuterSuite3() {
    registerSuite1();
}

describe('OracleBatchSigner (XPRICEB batch-signing round)', registerOuterSuite3);
