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
        let rounds = baseRounds();
        let res = await mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, rounds);
        mesh.stop();

        expect(res.met).to.equal(true);
        expect(res.firstRound).to.equal(100);
        expect(res.lastRound).to.equal(105);
        expect(res.btcBlockHeight).to.equal(5005);
        // 4 distinct sources, weight 1 each: 3*tally > 2*S needs 3 signers.
        expect(res.sigs.length).to.be.at.least(3);

        // Every returned signature verifies over the ONE canonical, and the canonical
        // is what the shared builder produces for this window.
        let canonical = buildCanonical(100, 105, 5005, rounds);
        expect(res.canonical).to.equal(canonical);
        for (let s of res.sigs) {
            expect(mesh.pubkeys).to.include(s.pubkey);
            expect(ValidatorIdentity.verify(canonical, s.sig, s.pubkey)).to.equal(true);
        }
        // No duplicate signers in the set the publisher would put on the wire.
        expect(new Set(res.sigs.map(s => s.pubkey)).size).to.equal(res.sigs.length);

        expect(mesh.nodes[0].signer.getStats().batchSignQuorums).to.equal(1);
        expect(mesh.nodes[0].signer.getStats().batchSignTimeouts).to.equal(0);
    };

// THE POINT OF THE ROW. One altered price is enough: the honest peers rebuild
// the canonical from their own rows, see a different string, and stay silent.
const testCase2 = async function () {
        let mesh = buildMesh(4);
        let fabricated = clone(baseRounds());
        fabricated[3].pairs[0].price = '99999';          // a price no honest hub finalized

        let res = await mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, fabricated);
        mesh.stop();

        expect(res.met).to.equal(false);
        // The leader is alone with its own signature; a quorum of 3 never forms.
        expect(res.sigs.length).to.equal(1);
        expect(res.sigs[0].pubkey).to.equal(mesh.pubkeys[0]);
        expect(mesh.nodes[0].signer.getStats().batchSignTimeouts).to.equal(1);
        expect(mesh.nodes[0].signer.getStats().batchSignQuorums).to.equal(0);

        for (let i = 1; i < mesh.nodes.length; i++) {
            let stats = mesh.nodes[i].signer.getStats();
            expect(stats.batchSignRefusals, 'peer ' + i + ' refused').to.equal(1);
            expect(stats.batchSignaturesProvided, 'peer ' + i + ' signed nothing').to.equal(0);
            // Silence, not a NACK: nothing at all went back on the wire.
            expect(mesh.nodes[i].sent).to.have.length(0);
        }
    };

const testCase3 = async function () {
        let mesh = buildMesh(4);
        let partial = clone(baseRounds()).filter(r => r.round !== 103);

        let res = await mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, partial);
        mesh.stop();

        expect(res.met).to.equal(false);
        expect(res.sigs.length).to.equal(1);
        for (let i = 1; i < mesh.nodes.length; i++) {
            expect(mesh.nodes[i].signer.getStats().batchSignRefusals).to.equal(1);
            expect(mesh.nodes[i].sent).to.have.length(0);
        }
    };

const testCase4 = async function () {
        // The leader holds a seventh round; nobody else finalized it.
        let mesh = buildMesh(4, {
            perNodeRounds: (i) => {
                let rounds = baseRounds();
                if (i === 0) rounds.push({
                    round: 106, timestamp: 1700003600, btcBlockHeight: 5006,
                    pairs: [{ pair: 'BTC/USD', price: '60006' }, { pair: 'LTC/USD', price: '86' }]
                });
                return rounds;
            }
        });
        let leaderRounds = baseRounds();
        leaderRounds.push({
            round: 106, timestamp: 1700003600, btcBlockHeight: 5006,
            pairs: [{ pair: 'BTC/USD', price: '60006' }, { pair: 'LTC/USD', price: '86' }]
        });

        let res = await mesh.nodes[0].signer.collectBatchSignatures(100, 106, 5006, leaderRounds);
        mesh.stop();

        expect(res.met).to.equal(false);
        expect(res.sigs.length).to.equal(1);
        for (let i = 1; i < mesh.nodes.length; i++) {
            expect(mesh.nodes[i].signer.getStats().batchSignRefusals).to.equal(1);
            expect(mesh.nodes[i].sent).to.have.length(0);
        }
    };

const testCase5 = async function () {
        // Round 102 is 'skipped' everywhere, so no honest batch contains it and the
        // canonical every node builds simply omits it.
        let withSkip = baseRounds().map(r => (r.round === 102 ? Object.assign({}, r, { status: 'skipped' }) : r));
        let mesh = buildMesh(4, { rounds: withSkip });

        let proposal = baseRounds().filter(r => r.round !== 102);
        let res = await mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, proposal);
        mesh.stop();

        expect(res.met).to.equal(true);
        expect(res.sigs.length).to.be.at.least(3);
        expect(res.canonical).to.equal(buildCanonical(100, 105, 5005, proposal));
        for (let i = 1; i < mesh.nodes.length; i++) {
            expect(mesh.nodes[i].signer.getStats().batchSignRefusals).to.equal(0);
            expect(mesh.nodes[i].signer.getStats().batchSignaturesProvided).to.equal(1);
        }
    };

const testCase6 = async function () {
        // Every peer's round 101 was marked 'disputed' by the retraction fence; the
        // leader still holds it as finalized and proposes it.
        let mesh = buildMesh(4, {
            perNodeRounds: (i) => (i === 0 ? baseRounds()
                : baseRounds().map(r => (r.round === 101 ? Object.assign({}, r, { status: 'disputed' }) : r)))
        });

        let res = await mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, baseRounds());
        mesh.stop();

        expect(res.met).to.equal(false);
        for (let i = 1; i < mesh.nodes.length; i++)
            expect(mesh.nodes[i].signer.getStats().batchSignRefusals).to.equal(1);
    };

const testCase7 = async function () {
        // mainnet STAKE_WEIGHTED_QUORUM activates at 961000; anchors 960998..961001
        // put the first and last rounds on opposite sides of it.
        let straddling = [960998, 960999, 961000, 961001].map((h, i) => ({
            round:          200 + i,
            timestamp:      1700100000 + i * 600,
            btcBlockHeight: h,
            pairs: [{ pair: 'BTC/USD', price: String(70000 + i) }]
        }));
        let mesh = buildMesh(4, { network: 'mainnet', rounds: straddling });

        let res = await mesh.nodes[0].signer.collectBatchSignatures(200, 203, 961001, straddling);
        mesh.stop();

        expect(res.met).to.equal(false);
        for (let i = 1; i < mesh.nodes.length; i++) {
            expect(mesh.nodes[i].signer.getStats().batchSignRefusals).to.equal(1);
            expect(mesh.nodes[i].sent).to.have.length(0);
        }
    };

const testCase8 = async function () {
        let mesh = buildMesh(4);
        // Detach every peer: the requests go nowhere, exactly like a partitioned hub.
        for (let i = 1; i < mesh.nodes.length; i++) mesh.nodes[i].signer.stop();

        let started = Date.now();
        let res = await mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, baseRounds());
        mesh.stop();

        expect(res.met).to.equal(false);
        expect(res.sigs.length).to.equal(1);          // the leader's own, for observability only
        expect(Date.now() - started).to.be.at.least(200);
        let stats = mesh.nodes[0].signer.getStats();
        expect(stats.batchSignTimeouts).to.equal(1);
        expect(stats.batchSignRounds).to.equal(1);
        expect(stats.batchSignQuorums).to.equal(0);
        expect(stats.batchSignTimeoutMs).to.equal(250);
    };

const testCase9 = async function () {
        let mesh = buildMesh(4);
        let leader = mesh.nodes[0];
        let rounds = baseRounds();
        let canonical = buildCanonical(100, 105, 5005, rounds);

        // Detach the honest peers so only the injected messages reach the round.
        for (let i = 1; i < mesh.nodes.length; i++) mesh.nodes[i].signer.stop();

        let outsider = new ValidatorIdentity('ab'.repeat(32));
        let pending = leader.signer.collectBatchSignatures(100, 105, 5005, rounds);

        // Not in the price set at the anchor: a perfectly valid signature, ignored.
        await leader.signer.handleSign({ type: 'XPRICEB_SIGN', data: {
            first_round: 100, last_round: 105,
            pubkey: outsider.getPubkeyHex().toLowerCase(), sig: outsider.sign(canonical) } });
        // A member, but the signature is over other bytes.
        await leader.signer.handleSign({ type: 'XPRICEB_SIGN', data: {
            first_round: 100, last_round: 105,
            pubkey: mesh.pubkeys[1], sig: mesh.nodes[1].identity.sign(canonical + 'x') } });
        // A member signing a DIFFERENT window: wrong round, ignored.
        await leader.signer.handleSign({ type: 'XPRICEB_SIGN', data: {
            first_round: 100, last_round: 104,
            pubkey: mesh.pubkeys[2], sig: mesh.nodes[2].identity.sign(canonical) } });

        let res = await pending;
        mesh.stop();
        expect(res.met).to.equal(false);
        expect(res.sigs.length).to.equal(1);
    };

function registerSuite1() {
    it('collects a quorum when the leader proposes what every peer independently re-derives', testCase1);
    it('refuses a dishonest leader: one altered price, no quorum, every honest peer silent', testCase2);
    it('refuses a proposal that omits a round the peer holds', testCase3);
    it('refuses a proposal carrying a round the peer does not have', testCase4);
    it('signs a window containing a fully skipped round: legitimate absence must not block', testCase5);
    it('refuses a round a reorg retracted (status disputed is not signable content)', testCase6);
    it('refuses a window straddling an armed oracle flag day', testCase7);
    it('counts a timeout and publishes nothing when no peer answers', testCase8);
    it('ignores an XPRICEB_SIGN from a non-member and one carrying a bad signature', testCase9);
}

function registerOuterSuite1() {
    registerSuite1();
}

describe('OracleBatchSigner (XPRICEB batch-signing round)', registerOuterSuite1);
