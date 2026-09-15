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

// A co-signature is the last thing a leader waits on before it broadcasts,
// so it is the only local evidence a FOLLOWER has that a leader's DOGE tx may
// already be in flight and merely unmined. OraclePublisher's takeover reads this
// memo to defer instead of re-publishing over a live transaction.
const testCase1 = async function () {
            let mesh   = buildMesh(4);
            let before = Date.now();
            await mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, baseRounds());
            let after  = Date.now();
            mesh.stop();

            for (let i = 1; i < mesh.nodes.length; i++) {
                let at = mesh.nodes[i].signer.coSignedAt(100, 105);
                expect(at, 'follower ' + i).to.be.a('number');
                expect(at).to.be.within(before, after);
                expect(mesh.nodes[i].signer.getStats().batchWindowsCoSigned).to.equal(1);
            }
        };

const testCase2 = async function () {
            let mesh = buildMesh(4);
            await mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, baseRounds());
            mesh.stop();

            let follower = mesh.nodes[1].signer;
            expect(follower.coSignedAt(96, 107)).to.be.a('number');   // window contains the sub-range
            expect(follower.coSignedAt(105, 110)).to.be.a('number');  // overlaps at one round
            expect(follower.coSignedAt(106, 111)).to.equal(null);     // the NEXT window, disjoint
            expect(follower.coSignedAt(90, 99)).to.equal(null);
        };

const testCase3 = async function () {
            let mesh = buildMesh(4);
            mesh.stop();
            expect(mesh.nodes[1].signer.coSignedAt(100, 105)).to.equal(null);
            expect(mesh.nodes[1].signer.getStats().batchWindowsCoSigned).to.equal(0);
        };

const testCase4 = async function () {
            // One node's rounds disagree, so it withholds its signature; a hub that
            // never signed never told a leader it could broadcast.
            let divergent = baseRounds().map(r => (r.round === 102
                ? Object.assign({}, r, { pairs: [{ pair: 'BTC/USD', price: '1.00' }] })
                : r));
            let mesh = buildMesh(4, { perNodeRounds: (i) => (i === 1 ? divergent : baseRounds()) });
            await captureWarnings(() =>
                mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, baseRounds()));
            mesh.stop();

            expect(mesh.nodes[1].signer.coSignedAt(100, 105)).to.equal(null);
            expect(mesh.nodes[2].signer.coSignedAt(100, 105)).to.be.a('number');
        };

const testCase5 = function () {
            let mesh   = buildMesh(1);
            let signer = mesh.nodes[0].signer;
            for (let w = 0; w < 300; w++) signer.noteCoSigned(w * 6, w * 6 + 5);
            mesh.stop();

            expect(signer.getStats().batchWindowsCoSigned).to.equal(256);
            expect(signer.coSignedAt(0, 5)).to.equal(null);            // evicted
            expect(signer.coSignedAt(299 * 6, 299 * 6 + 5)).to.be.a('number');
        };

function registerSuite1() {
    it('records the moment this hub co-signed a leader\'s window', testCase1);
    it('answers on OVERLAP, so a split window still reports its signed sub-range', testCase2);
    it('reports nothing for a window the leader never asked this hub to sign', testCase3);
    it('records nothing when the co-signature is REFUSED', testCase4);
    it('bounds the memo, evicting the oldest windows first', testCase5);
}

function registerOuterSuite4() {
    describe('the co-signature memo read by the takeover cooldown', registerSuite1);
}

describe('OracleBatchSigner (XPRICEB batch-signing round)', registerOuterSuite4);
