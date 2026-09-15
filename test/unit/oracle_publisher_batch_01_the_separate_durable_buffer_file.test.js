'use strict';

const { fs, sinon, expect, OraclePublisher, ME, PEER1, PEER2, roundFixture,
    bufferedFixture, makeDb, makePublisher, readJsonl, instances,
    cleanupPublisherBatch } = require('./oracle_publisher_batch.test.js');

let logs;

// ───────────────────────────────────── the durable buffer (D9)

const testCase1 = async function () {
            let h = makePublisher();
            await h.p.start();
            await h.p.onRoundFinalized(roundFixture(0));

            let buffered = readJsonl(h.bufferPath);
            expect(buffered).to.have.length(1);
            expect(buffered[0].round).to.equal(0);
            expect(buffered[0].pairs).to.deep.equal([
                { pair: 'BTC/USD', price: '60000.12' },
                { pair: 'LTC/USD', price: '80.5' }
            ]);
            // The whole point of D9: a buffered round must never be reachable by the
            // publish pass, which broadcasts everything it reads.
            expect(readJsonl(h.queuePath)).to.have.length(0);
            expect(h.broadcasts).to.have.length(0);
        };

const testCase2 = async function () {
            // There is no activation stamp: the platform is not live, so there is no
            // replay history for a gate to protect, and a gate nobody remembers to arm
            // is worse than no gate. A round buffers wherever it finalizes.
            for (const network of ['mainnet', 'testnet', 'regtest']) {
                let h = makePublisher({ network });
                await h.p.start();
                await h.p.onRoundFinalized(roundFixture(0));

                expect(readJsonl(h.bufferPath), network).to.have.length(1);
                expect(h.broadcasts, network).to.have.length(0);
            }
        };

const testCase3 = async function () {
            // A standalone hub reads network as '' (it is derived from the p2p config),
            // and while a GATE would have failed closed on that and quietly emitted v0,
            // an ungated rail cannot: one hub emitting a wire its peers do not expect
            // is the split this removal exists to make unreachable.
            let h = makePublisher({ network: '' });
            await h.p.start();
            await h.p.onRoundFinalized(roundFixture(0));
            expect(readJsonl(h.bufferPath)).to.have.length(1);
            expect(h.broadcasts).to.have.length(0);
        };

const testCase4 = async function () {
            // Three publishers, this hub sorts to a rank that does not lead window 0.
            let h = makePublisher({ publishers: [ME, PEER1, PEER2] });
            await h.p.start();
            for (let r = 0; r < 3; r++) await h.p.onRoundFinalized(roundFixture(r));
            expect(readJsonl(h.bufferPath)).to.have.length(3);
        };

const testCase5 = async function () {
            let h = makePublisher();
            await h.p.start();
            await h.p.onRoundFinalized(roundFixture(1));
            await h.p.onRoundFinalized(roundFixture(2));

            let second = new OraclePublisher(h.hub);
            instances.push(second);
            await second.start();
            expect(second._buffer.size).to.equal(2);
            expect(second.bufferedRange(0, 5).map(r => r.round)).to.deep.equal([1, 2]);
        };

const testCase6 = async function () {
            let h = makePublisher({ cfg: { ORACLE_BATCH_BUFFER_MAX_ROUNDS: 3 } });
            await h.p.start();
            for (let r = 0; r < 5; r++) await h.p.onRoundFinalized(roundFixture(r));
            expect(h.p._buffer.size).to.equal(3);
            expect(Array.from(h.p._buffer.keys()).sort((a, b) => a - b)).to.deep.equal([2, 3, 4]);
            expect(readJsonl(h.bufferPath).map(e => e.round)).to.deep.equal([2, 3, 4]);
        };

const testCase7 = async function () {
            let db = makeDb({ snapshots: [
                { round_number: 0, block_timestamp: 1800000000, status: 'finalized', batch: true },
                { round_number: 1, block_timestamp: 1800000600, status: 'finalized', batch: true }
            ] });
            let h = makePublisher({ db: db, publishers: [ME, PEER1, PEER2] });
            await h.p.start();
            for (let r = 0; r < 3; r++) await h.p.onRoundFinalized(roundFixture(r));
            expect(h.p._buffer.size).to.equal(3);

            await h.p.pruneObservedWindow(0, 5);
            expect(Array.from(h.p._buffer.keys())).to.deep.equal([2]);
            expect(readJsonl(h.bufferPath).map(e => e.round)).to.deep.equal([2]);
        };

// Half one. price_snapshots is last-write-wins (ON DUPLICATE KEY
// UPDATE); this buffer was first-write-wins. One round finalizing twice with
// different content therefore left the two stores permanently out of step, and
// since the leader proposes from the buffer while every co-signer re-derives
// from price_snapshots, the whole window became unsignable forever.
const testCase8 = async function () {
                let h = makePublisher();
                await h.p.start();
                await h.p.onRoundFinalized(roundFixture(7));
                // Same round number, the second finalization's timestamp and prices.
                await h.p.onRoundFinalized(roundFixture(7, {
                    time:  1800004800,
                    pairs: [{ coinPair: 'BTC/USD', price: '61111.11' },
                            { coinPair: 'LTC/USD', price: '81.5' }]
                }));

                let buffered = h.p._buffer.get(7);
                expect(buffered.timestamp).to.equal(1800004800);
                expect(buffered.pairs).to.deep.equal([
                    { pair: 'BTC/USD', price: '61111.11' },
                    { pair: 'LTC/USD', price: '81.5' }
                ]);
                // The file is compacted to ONE line for the round, carrying the new copy.
                let onDisk = readJsonl(h.bufferPath);
                expect(onDisk).to.have.length(1);
                expect(onDisk[0].timestamp).to.equal(1800004800);
                expect(logs.warn.join('\n')).to.match(/round 7 re-finalized with different content/);
            };

const testCase9 = async function () {
                let h = makePublisher();
                await h.p.start();
                await h.p.onRoundFinalized(roundFixture(7));
                await h.p.onRoundFinalized(roundFixture(7, { time: 1800004800 }));

                let second = new OraclePublisher(h.hub);
                instances.push(second);
                await second.start();
                expect(second._buffer.size).to.equal(1);
                expect(second._buffer.get(7).timestamp).to.equal(1800004800);
            };

const testCase10 = async function () {
                let h = makePublisher();
                await h.p.start();
                await h.p.onRoundFinalized(roundFixture(7));
                let after = fs.statSync(h.bufferPath).mtimeMs;
                await h.p.onRoundFinalized(roundFixture(7));
                await h.p.onRoundFinalized(roundFixture(7));

                expect(readJsonl(h.bufferPath)).to.have.length(1);
                expect(fs.statSync(h.bufferPath).mtimeMs).to.equal(after);
                expect(logs.warn.join('\n')).to.not.match(/re-finalized with different content/);
            };

const testCase11 = async function () {
                let h = makePublisher();
                await h.p.start();
                await h.p.onRoundFinalized(roundFixture(7));
                await h.p.onRoundFinalized(roundFixture(7, {
                    pairs: [{ coinPair: 'LTC/USD', price: '80.5' },
                            { coinPair: 'BTC/USD', price: '60000.12' }]
                }));
                expect(readJsonl(h.bufferPath)).to.have.length(1);
                expect(logs.warn.join('\n')).to.not.match(/re-finalized with different content/);
            };

// The regression as the federation experienced it: after the second
// finalization, what the leader PROPOSES has to be what its own
// price_snapshots holds, or no peer can ever reproduce it.
const testCase12 = async function () {
                let db = makeDb({ snapshots: [] });
                let h = makePublisher({ db: db });
                await h.p.start();
                for (let r = 0; r < 6; r++) await h.p.onRoundFinalized(roundFixture(r));
                await h.p.onRoundFinalized(roundFixture(5, {
                    time:  1800009999,
                    pairs: [{ coinPair: 'BTC/USD', price: '70000.00' }]
                }));

                await h.p._assembleWindow(0);
                expect(h.signer.calls).to.have.length(1);
                let proposed = h.signer.collectBatchSignatures.firstCall.args[3];
                let last = proposed[proposed.length - 1];
                expect(last.round).to.equal(5);
                expect(last.timestamp).to.equal(1800009999);
                expect(last.pairs).to.deep.equal([{ pair: 'BTC/USD', price: '70000.00' }]);
            };

function registerSuite2() {
    it('replaces the buffered copy when the content CHANGED, in memory and on disk', testCase8);
    it('survives a restart carrying the SECOND copy, not the first', testCase9);
    it('is a no-op when the re-finalization is IDENTICAL, so a replay costs no disk', testCase10);
    it('treats a re-ordered pair list as identical: the canonical builder sorts pairs anyway', testCase11);
    it('proposes the re-finalized content to the signing round', testCase12);
}

// Half two. receiveBatch dedupes per round, so a landed six-round
// batch typically stamps only the one round this hub was missing; the other
// five keep their v0 proof. Pruning only the stamped rows left a published
// window buffered forever, and every later leader re-proposed it.
const testCase13 = async function () {
            let proof = JSON.stringify({
                batch: { first_round: 0, last_round: 5, btc_block_height: 800005 },
                sigs: []
            });
            let db = makeDb({ snapshots: [
                // Only round 3 was missing locally, so only round 3 carries the stamp.
                { round_number: 3, block_timestamp: 1800001800, status: 'finalized',
                  batch: true, proof: proof }
            ] });
            let h = makePublisher({ db: db, publishers: [ME, PEER1, PEER2] });
            await h.p.start();
            for (let r = 0; r < 8; r++) await h.p.onRoundFinalized(roundFixture(r));

            let pruned = await h.p.pruneObservedWindow(0, 5);
            expect(pruned).to.equal(6);
            // Rounds 6 and 7 are outside the batch's claimed range and stay buffered.
            expect(Array.from(h.p._buffer.keys()).sort((a, b) => a - b)).to.deep.equal([6, 7]);
        };

// The healing half of this fix. The buffer fix above stops a NEW drift; a hub
// that already drifted (its buffered round 107 predates the fix) still holds a
// window no peer can co-sign until assembly reconciles it.

// A DB seed row shaped the way makeDb's reconcile branch expands it.
function snapRow(round, opts) {
                opts = opts || {};
                return {
                    round_number:    round,
                    status:          'finalized',
                    reference_block: opts.anchor !== undefined ? opts.anchor : 800000 + round,
                    block_timestamp: opts.time   !== undefined ? opts.time   : 1800000000 + round * 600,
                    batch:           opts.batch === true,
                    pairs:           opts.pairs || [{ pair: 'BTC/USD', price: '60000.12' },
                                                    { pair: 'LTC/USD', price: '80.5' }]
                };
            }

const testCase14 = async function () {
                // The testnet shape: the DB moved round 5 on to a later timestamp and a
                // new price set, and the buffer was left holding the superseded copy.
                let snapshots = [];
                for (let r = 0; r < 6; r++) snapshots.push(snapRow(r));
                snapshots[5] = snapRow(5, { time: 1800009999,
                                            pairs: [{ pair: 'BTC/USD', price: '70000.00' }] });
                let h = makePublisher({ db: makeDb({ snapshots: snapshots }) });
                await h.p.start();
                // Buffer the pre-drift content, as the hub did before the DB moved.
                for (let r = 0; r < 6; r++) await h.p.onRoundFinalized(roundFixture(r));

                await h.p._assembleWindow(0);

                let proposed = h.signer.collectBatchSignatures.firstCall.args[3];
                let last = proposed[proposed.length - 1];
                expect(last.round).to.equal(5);
                expect(last.timestamp).to.equal(1800009999);
                expect(last.pairs).to.deep.equal([{ pair: 'BTC/USD', price: '70000.00' }]);
                expect(logs.warn.join('\n')).to.match(/buffered round 5 disagreed with this hub's own price_snapshots/);
                // The refreshed copy is durable, so the next restart proposes it too.
                expect(readJsonl(h.bufferPath).find(e => e.round === 5).timestamp).to.equal(1800009999);
            };

const testCase15 = async function () {
                let snapshots = [];
                for (let r = 0; r < 6; r++) snapshots.push(snapRow(r));
                // Round 2 came back from a landed batch, so its reference_block is the
                // LANDING chain's height, not a BTC anchor.
                snapshots[2] = snapRow(2, { batch: true, anchor: 67856096 });
                let h = makePublisher({ db: makeDb({ snapshots: snapshots }) });
                await h.p.start();
                for (let r = 0; r < 6; r++) await h.p.onRoundFinalized(roundFixture(r));

                expect(await h.p.reconcileBufferedWindow(0, 5)).to.equal(1);
                expect(h.p._buffer.has(2)).to.equal(false);
                // The landing height never reaches the buffer, let alone a proposal.
                for (let e of h.p._buffer.values()) expect(e.btcBlockHeight).to.not.equal(67856096);
                expect(logs.warn.join('\n')).to.match(/dropping buffered round 2 .* already landed on chain/);
            };

const testCase16 = async function () {
                let snapshots = [];
                for (let r = 0; r < 6; r++) snapshots.push(snapRow(r));
                let h = makePublisher({ db: makeDb({ snapshots: snapshots }) });
                await h.p.start();
                for (let r = 0; r < 6; r++) await h.p.onRoundFinalized(roundFixture(r));
                let before = readJsonl(h.bufferPath);

                expect(await h.p.reconcileBufferedWindow(0, 5)).to.equal(0);
                expect(readJsonl(h.bufferPath)).to.deep.equal(before);
                expect(logs.warn.join('\n')).to.not.match(/disagreed with this hub's own/);
            };

const testCase17 = async function () {
                let h = makePublisher({ db: makeDb({ snapshots: [snapRow(0), snapRow(3)] }) });
                await h.p.start();
                await h.p.onRoundFinalized(roundFixture(0));

                expect(await h.p.reconcileBufferedWindow(0, 5)).to.equal(0);
                expect(Array.from(h.p._buffer.keys())).to.deep.equal([0]);
            };

const testCase18 = async function () {
                // No `pairs` on the seed: the row reads back with no pair and no price,
                // which the canonical builder would turn into NaN.
                let h = makePublisher({ db: makeDb({ snapshots: [
                    { round_number: 0, status: 'finalized', block_timestamp: 1800009999 }
                ] }) });
                await h.p.start();
                await h.p.onRoundFinalized(roundFixture(0));

                expect(await h.p.reconcileBufferedWindow(0, 5)).to.equal(0);
                expect(h.p._buffer.get(0).timestamp).to.equal(1800000000);
                expect(h.p._buffer.get(0).pairs).to.have.length(2);
                expect(logs.warn.join('\n')).to.match(/skipping reconcile of buffered round 0/);
            };

const testCase19 = async function () {
                let db = makeDb({ snapshots: [] });
                db.doQuery = async (q) => {
                    if (/coin_pair/i.test(q)) throw new Error('connection lost');
                    return [];
                };
                let h = makePublisher({ db: db });
                await h.p.start();
                await h.p.onRoundFinalized(roundFixture(0));

                expect(await h.p.reconcileBufferedWindow(0, 5)).to.equal(0);
                expect(h.p._buffer.get(0).timestamp).to.equal(1800000000);
                expect(logs.warn.join('\n')).to.match(/cannot reconcile the buffered copy of window \[0,5\]/);
            };

function registerSuite3() {
    it('refreshes a drifted round so the leader proposes what its own DB holds', testCase14);
    it('sheds a round that arrived from a batch already on chain', testCase15);
    it('leaves an agreeing window completely alone', testCase16);
    it('never INVENTS a round: a finalized round with no buffered copy stays the self-check\'s case', testCase17);
    it('fails closed on a half-read round rather than overwriting good content', testCase18);
    it('proposes the buffer as-is when the DB read throws', testCase19);
}

const testCase20 = async function () {
            let db = makeDb({ snapshots: [
                { round_number: 3, block_timestamp: 1800001800, status: 'finalized',
                  batch: true, proof: '{"batch": truncated' }
            ] });
            let h = makePublisher({ db: db, publishers: [ME, PEER1, PEER2] });
            await h.p.start();
            for (let r = 0; r < 6; r++) await h.p.onRoundFinalized(roundFixture(r));

            expect(await h.p.pruneObservedWindow(0, 5)).to.equal(1);
            expect(Array.from(h.p._buffer.keys()).sort((a, b) => a - b)).to.deep.equal([0, 1, 2, 4, 5]);
        };

function registerSuite1() {
    it('sends a post-stamp finalized round to <queue>.buffer.jsonl and NOT to the publish queue', testCase1);
    it('buffers on EVERY network, because batching is not gated', testCase2);
    it('buffers even with no network configured, so a hub cannot fall back to the v0 rail', testCase3);
    it('buffers on a hub that is NOT the window leader, because leadership is unknown at buffer time', testCase4);
    it('reloads the buffer on restart', testCase5);
    it('bounds the buffer at ORACLE_BATCH_BUFFER_MAX_ROUNDS, dropping the oldest', testCase6);
    it('prunes a window once an on-chain batch covering it is observed locally (D29)', testCase7);
    describe('a round that re-finalizes', registerSuite2);
    it('prunes the WHOLE range a landed batch claims, not just the rows carrying its proof', testCase13);
    describe('reconciling the buffered window against price_snapshots', registerSuite3);
    it('falls back to the stamped round alone when the proof is unreadable', testCase20);
}

function registerOuterSuite1() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...args) => logs.log.push(args.join(' ')));
        sinon.stub(console, 'warn').callsFake((...args) => logs.warn.push(args.join(' ')));
        sinon.stub(console, 'error').callsFake((...args) => logs.error.push(args.join(' ')));
    });
    afterEach(function () {
        cleanupPublisherBatch();
    });
    describe('the separate durable buffer file', registerSuite1);
}

describe('OraclePublisher PRICE batch rail', registerOuterSuite1);
