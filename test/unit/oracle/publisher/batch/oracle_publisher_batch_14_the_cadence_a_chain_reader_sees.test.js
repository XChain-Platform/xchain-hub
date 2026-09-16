'use strict';

const {
    fs,
    os,
    path,
    crypto,
    sinon,
    expect,
    OraclePublisher,
    waitUntil,
    PRICE_BATCH_COMPRESSION_MARKER,
    inflatePriceBatchBody,
    DB_METHODS,
    PRICE_WIRE_MAX_BYTES,
    ME,
    PEER1,
    PEER2,
    hex,
    makeIdentity,
    sigsOf,
    pairsOf,
    roundFixture,
    bufferedFixture,
    makeSigner,
    makeSnapshot,
    makeDb,
    makePublisher,
    bodyOf,
    readJsonl,
    cleanupPublisherBatch
} = require('./oracle_publisher_batch.test.js');

let logs;

// ───────────────────────────────────── the cadence a chain reader sees

// The verify clause is a live one: PRICE gaps on a fee-bearing chain stay
// under the staleness bound for a FULL HOUR, and an action picked at a random
// moment in it still prices. It cannot be run here, but its shape can: drive the
// real scheduler through two hours of fleet-cadence rounds, take the round ranges
// off the wires it actually queued, and walk a reader across the hour those wires
// cover. The arithmetic module is already tested on its own; what this adds is
// that the SCHEDULER emits the windows that arithmetic assumes. A publisher that
// derived a 2-round ceiling and then went on batching six rounds a wire would
// pass every test in `knobs` and fail here, which is the failure that put the
// half-hourly fee gate behind an hourly rail in the first place.

const ROUND_S   = 600;    // ORACLE_ROUND_INTERVAL as the fleet runs it

const GRACE_S   = 300;    // ORACLE_BATCH_GRACE_MS, ditto

const RESERVE_S = 300;    // ORACLE_BATCH_LANDING_RESERVE_MS, budgeted

const BOUND_S   = 1800;   // ORACLE_MAX_PRICE_AGE_SECONDS, consensus-pinned

// roundFixture's own clock, which is one round every ROUND_S.
function tsOf(round) { return 1800000000 + round * ROUND_S; }

// When a wire covering [.., lastRound] becomes readable on chain, and what the
// newest snapshot it carries is dated. Both halves of what a fee-paying action
// is judged against.
function landing(lastRound) {
            return { readableAt: tsOf(lastRound) + GRACE_S + RESERVE_S, newest: tsOf(lastRound) };
        }

// The oldest the newest visible snapshot ever gets, walked second by second
// across the whole span these landings cover. Second-by-second rather than at the
// peaks alone because the verify clause is about an arbitrary moment, not a
// chosen one.
function peakSnapshotAge(landings) {
            let worst = 0;
            for (let t = landings[0].readableAt; t <= landings[landings.length - 1].readableAt; t++) {
                let newest = null;
                for (let l of landings) { if (l.readableAt <= t) newest = l.newest; }
                worst = Math.max(worst, t - newest);
            }
            return worst;
        }

const testCase1 = async function () {
            // The grace is shortened to 1ms so the case does not sleep five real minutes
            // per window; the age arithmetic below still uses the fleet's 300s, which is
            // the conservative direction (a longer grace than the run actually took).
            let h = makePublisher({ fleetCadence: true, cfg: { ORACLE_BATCH_GRACE_MS: 1 } });
            await h.p.start();
            expect(h.p.batchWindowRounds).to.equal(2);

            for (let r = 0; r < 12; r++) await h.p.onRoundFinalized(roundFixture(r));
            await waitUntil(() => h.signer.calls.length >= 6,
                { label: 'six 2-round windows to close and be proposed' });
            await h.p._windowChain;

            // What went on the wire, not what the config said would.
            let wires = h.signer.calls.map(c => [c.first, c.last]);
            expect(wires).to.deep.equal([[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11]]);
            expect(h.broadcasts).to.have.length(6);

            let landings = h.signer.calls.map(c => landing(c.last));
            // The span walked is longer than the hour the clause asks for.
            expect(landings[landings.length - 1].readableAt - landings[0].readableAt)
                .to.be.at.least(3600);
            // 1200s of window + 300s grace + 300s reserve, less the one second the walk
            // cannot sample: the next landing resets the age at exactly the peak instant,
            // so the sampled maximum sits one second below the open supremum of 1800s.
            expect(peakSnapshotAge(landings)).to.equal(1799);
            expect(peakSnapshotAge(landings)).to.be.at.most(BOUND_S);

            // And the publish gap itself, which is what the explorer shows as the gap
            // between consecutive PRICE actions.
            for (let i = 1; i < landings.length; i++) {
                expect(landings[i].newest - landings[i - 1].newest).to.equal(2 * ROUND_S);
                expect(landings[i].newest - landings[i - 1].newest).to.be.below(BOUND_S);
            }
        };

const testCase2 = async function () {
            // The regression this case exists to catch, priced with the same arithmetic
            // the passing case uses: an hourly rail leaves the newest snapshot 4200s old
            // against a 1800s gate, so a fee-bearing action fails for most of every hour.
            // This is the public testnet shape.
            let sixRoundWires = [landing(5), landing(11), landing(17)];
            // Same one-second sampling artefact as above, against a supremum of 4200s.
            expect(peakSnapshotAge(sixRoundWires)).to.equal(4199);
            expect(peakSnapshotAge(sixRoundWires)).to.be.above(BOUND_S);
        };

function registerSuite1() {
    it('keeps the newest snapshot inside the fee-price bound for every second of the hour', testCase1);
    it('measures the pre-fix 6-round window failing the same walk', testCase2);
}

function registerOuterSuite14() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...args) => logs.log.push(args.join(' ')));
        sinon.stub(console, 'warn').callsFake((...args) => logs.warn.push(args.join(' ')));
        sinon.stub(console, 'error').callsFake((...args) => logs.error.push(args.join(' ')));
    });
    afterEach(function () {
        cleanupPublisherBatch();
    });
    describe('the cadence a chain reader sees', registerSuite1);
}

describe('OraclePublisher PRICE batch rail', registerOuterSuite14);
