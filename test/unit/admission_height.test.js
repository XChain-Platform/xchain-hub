'use strict';

/*
 * admission_height.js - the hub-side producer of admission by height.
 *
 * These tests drive the four things the module owns, and each one is a failure the
 * spec names rather than a restatement of the code:
 *
 *   - the read sets, because a map that misses a reading chain leaves the row bound
 *     by two different rules at once;
 *   - the follower bound PER CHAIN, because a flat block window collapses DOGE's
 *     clock-skew tolerance from an hour to six minutes;
 *   - the refusals (an omitted chain, a stale tip), because the fail-closed
 *     direction is the whole design;
 *   - the canonical encoding's INJECTIVITY, because a map with two readings lets one
 *     honest quorum's signatures validate over two different admission heights.
 */

const { expect } = require('chai');

const ah  = require('../../src/lib/admission_height.js');
const act = require('../../src/mirror_admission_activation.js');

// ─── arming, because a DEFAULT run must drive BOTH eras ──────────────────────
//
// Every activation map in this train is deliberately inert, and the regtest key is the only
// per-process arming seam the codebase has: mirror_admission_activation.js reads it from the
// environment at MODULE LOAD, so setting process.env in a before() hook arms nothing. The
// five most consensus-critical cases in this file skip in an unarmed process, and a bare
// `this.skip()` behind an activation nobody arms is a case CI and every casual run never
// drives, so the arming is done here rather than left to the launcher.
//
// So both eras are driven explicitly, on the shape priceV0CanonicalAdmission.test.js
// established: purge the twin, the admission seam and the two engine classes that closed over
// them from the require cache, set (or clear) the height, re-require, and put every cache
// entry and the variable back byte-exact afterwards. Arming is scoped to the describe that
// asks for it, never to the process, so the rest of this file and the rest of the run still
// see the tree they were written against.
const ERA_MODULES = [
    '../../src/mirror_admission_activation.js',
    '../../src/lib/admission_height.js',
    '../../src/CrossChainDexEngine.js',
    '../../src/CrossChainBridgeEngine.js'
];

// The regtest producer activation the armed describes below use. A row at this height is an
// admission-era row and a row below it is a legacy row, so one armed process drives both.
const ERA_AT = 1000;

// height: a number to arm regtest at that height, or null to force regtest INERT whatever
// the process was launched with. The inert direction is armed too, deliberately: a suite
// that only drove whichever way the environment happened to point is the defect this
// replaces, and it fails in whichever direction the operator did not happen to launch.
function withAdmissionActivation(height){
    const paths    = ERA_MODULES.map(m => require.resolve(m));
    const saved    = paths.map(p => [p, require.cache[p]]);
    const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    for(const p of paths) delete require.cache[p];
    if(height === null) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    else process.env.XC_MIRROR_ADMISSION_ACTIVATION = String(height);

    const out = {
        ah:     require('../../src/lib/admission_height.js'),
        act:    require('../../src/mirror_admission_activation.js'),
        // _canonicalMatch reads nothing off `this`, so it is driven off the prototype rather
        // than through a constructed engine with a hub, a db and a consensus behind it.
        DEX:    require('../../src/CrossChainDexEngine.js').prototype._canonicalMatch,
        BRIDGE: require('../../src/CrossChainBridgeEngine.js').prototype._canonicalMatch,
        restore(){
            for(const [p, mod] of saved){
                if(mod === undefined) delete require.cache[p]; else require.cache[p] = mod;
            }
            if(savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
            else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
        }
    };
    return out;
}

describe('admission_height: the measured read sets', () => {

    it('a match is read by a_chain and b_chain', () => {
        expect(ah.admissionReadSet('cross_chain_matches', { a_chain: 'BTC', b_chain: 'DOGE' }))
            .to.deep.equal(['BTC', 'DOGE']);
    });

    it('a same-chain match names its one chain once', () => {
        expect(ah.admissionReadSet('cross_chain_matches', { a_chain: 'LTC', b_chain: 'LTC' }))
            .to.deep.equal(['LTC']);
    });

    it('a call is read by target_chain and source_chain', () => {
        expect(ah.admissionReadSet('cross_chain_calls', { target_chain: 'DOGE', source_chain: 'BTC' }))
            .to.deep.equal(['BTC', 'DOGE']);
    });

    it('a bridge transfer is read by dest_chain alone', () => {
        expect(ah.admissionReadSet('bridge_transfers', { src_chain: 'BTC', dest_chain: 'LTC' }))
            .to.deep.equal(['LTC']);
    });

    it('attest responses and anchor-reward attestations are BTC only', () => {
        expect(ah.admissionReadSet('attestation_responses', {})).to.deep.equal(['BTC']);
        expect(ah.admissionReadSet('anchor_reward_attestations', { chain: 'DOGE' })).to.deep.equal(['BTC']);
    });

    it('a policy snapshot is read by EVERY federation chain, not by its own pair', () => {
        // The sharp case: the consuming select carries no chain clause at all, so the
        // origin_chain on the row tells you nothing about who reads it.
        expect(ah.admissionReadSet('policy_snapshots', { origin_chain: 'BTC' }, ['DOGE', 'BTC', 'LTC']))
            .to.deep.equal(['BTC', 'DOGE', 'LTC']);
    });

    it('an every-chain rail with no federation chain list REFUSES rather than stamping an empty map', () => {
        // An empty map admits the row on no chain at all, which is silently different
        // from the legacy rule and different again from what the producer intended.
        expect(() => ah.admissionReadSet('policy_snapshots', {}, [])).to.throw(/EVERY chain/);
        expect(() => ah.admissionReadSet('oracle_prices', {})).to.throw(/no source_chain/);
    });

    it('a table with no measured read set throws rather than defaulting', () => {
        expect(() => ah.admissionReadSet('some_new_mirror_table', {})).to.throw(/no measured read set/);
    });

    it('a row naming an unusable chain refuses rather than coercing it', () => {
        expect(() => ah.admissionReadSet('bridge_transfers', { dest_chain: 'not a chain' }))
            .to.throw(/unusable chain/);
    });
});

describe('admission_height: the stamp', () => {

    it('is tip + margin on every chain in the read set, the SAME block count on each', () => {
        let map = ah.admitBlocks(['BTC', 'DOGE'], { BTC: 900000, DOGE: 5000000 }, 'cross_chain_matches');
        // Default margin is 4 blocks, and it is four blocks of each chain rather than a
        // duration converted per chain: the conversion is what the admission axis deletes.
        expect(map).to.deep.equal({ BTC: 900004, DOGE: 5000004 });
        expect(map.BTC - 900000).to.equal(map.DOGE - 5000000);
    });

    it('uses each table\'s own margin', () => {
        expect(ah.admitBlocks(['BTC'], { BTC: 100 }, 'attestation_responses')).to.deep.equal({ BTC: 101 });
        expect(ah.admitBlocks(['BTC'], { BTC: 100 }, 'oracle_prices')).to.deep.equal({ BTC: 101 });
        expect(ah.admitBlocks(['BTC'], { BTC: 100 }, 'anchor_reward_attestations')).to.deep.equal({ BTC: 244 });
        expect(ah.admitBlocks(['BTC'], { BTC: 100 }, 'policy_snapshots')).to.deep.equal({ BTC: 104 });
    });

    it('REFUSES when any chain in the read set has no fresh tip, and names the chain', () => {
        // C4: a guessed admission height forks the federation; a refusal stalls one rail.
        expect(() => ah.admitBlocks(['BTC', 'DOGE'], { BTC: 900000, DOGE: null }, 'cross_chain_matches'))
            .to.throw(/no fresh admission tip for DOGE/);
        expect(() => ah.admitBlocks(['BTC', 'DOGE'], { BTC: 900000 }, 'cross_chain_matches'))
            .to.throw(/no fresh admission tip for DOGE/);
    });

    it('does not read a non-integer tip as a height', () => {
        for(let bad of ['', 'x', NaN, 1.5, -1, undefined, null])
            expect(ah.missingAdmissionTips(['BTC'], { BTC: bad }), String(bad)).to.deep.equal(['BTC']);
        // The one that matters most: '' and null both coerce to 0 through Number(), and a
        // tip of 0 would stamp an admission height of 4, admissible at every live block.
        expect(ah.missingAdmissionTips(['BTC'], { BTC: '' })).to.deep.equal(['BTC']);
    });
});

describe('admission_height: the follower bound is PER CHAIN', () => {

    it('BTC and DOGE do NOT share a bound, which a flat window would make them', () => {
        // 3600 s of tolerance on each chain: BTC 6 blocks, DOGE 60. A flat 6 would refuse
        // an honest DOGE row between hubs whose tips differ by three blocks.
        expect(act.admitMaxFutureBlocks('BTC')).to.equal(6);
        expect(act.admitMaxFutureBlocks('DOGE')).to.equal(60);
        expect(act.admitMaxFutureBlocks('LTC')).to.equal(24);

        // Height tip+30 is inside DOGE's window and outside BTC's, with the same tip.
        expect(ah.checkAdmitBlocks(['DOGE'], { DOGE: 1030 }, { DOGE: 1000 }).ok).to.equal(true);
        expect(ah.checkAdmitBlocks(['BTC'],  { BTC: 1030 },  { BTC: 1000 }).ok).to.equal(false);
    });

    it('refuses a height at or below the follower\'s own tip', () => {
        // A row admissible at a block that already exists lets a producer backdate it
        // into a block its peers have already committed.
        expect(ah.checkAdmitBlocks(['BTC'], { BTC: 1000 }, { BTC: 1000 }).ok).to.equal(false);
        expect(ah.checkAdmitBlocks(['BTC'], { BTC: 999 },  { BTC: 1000 }).ok).to.equal(false);
        expect(ah.checkAdmitBlocks(['BTC'], { BTC: 1001 }, { BTC: 1000 }).ok).to.equal(true);
        expect(ah.checkAdmitBlocks(['BTC'], { BTC: 1006 }, { BTC: 1000 }).ok).to.equal(true);
        expect(ah.checkAdmitBlocks(['BTC'], { BTC: 1007 }, { BTC: 1000 }).ok).to.equal(false);
    });

    it('REFUSES a proposal whose map omits a chain in the read set (C38)', () => {
        let v = ah.checkAdmitBlocks(['BTC', 'DOGE'], { BTC: 1001 }, { BTC: 1000, DOGE: 2000 });
        expect(v.ok).to.equal(false);
        expect(v.chain).to.equal('DOGE');
        expect(v.reason).to.match(/omits DOGE/);
    });

    it('refuses a map carrying a chain that does not read the row', () => {
        let v = ah.checkAdmitBlocks(['BTC'], { BTC: 1001, LTC: 5001 }, { BTC: 1000, LTC: 5000 });
        expect(v.ok).to.equal(false);
        expect(v.chain).to.equal('LTC');
    });

    it('refuses when the follower has no tip of its own for a reading chain', () => {
        let v = ah.checkAdmitBlocks(['BTC', 'DOGE'], { BTC: 1001, DOGE: 2004 }, { BTC: 1000 });
        expect(v.ok).to.equal(false);
        expect(v.chain).to.equal('DOGE');
        expect(v.reason).to.match(/no own admission tip/);
    });

    it('a stamped map passes the bound of a follower whose tip matches the producer\'s', () => {
        let map = ah.admitBlocks(['BTC', 'DOGE'], { BTC: 900000, DOGE: 5000000 }, 'cross_chain_matches');
        expect(ah.checkAdmitBlocks(['BTC', 'DOGE'], map, { BTC: 900000, DOGE: 5000000 }).ok).to.equal(true);
        // And still passes when the follower trails by a couple of blocks on each chain.
        expect(ah.checkAdmitBlocks(['BTC', 'DOGE'], map, { BTC: 899998, DOGE: 4999998 }).ok).to.equal(true);
    });
});

describe('admission_height: the canonical encoding is injective', () => {

    it('spells the map as ASCII-ordered CODE:digits joined by commas', () => {
        expect(ah.encodeAdmitBlocks({ DOGE: 5000004, BTC: 900004 })).to.equal('BTC:900004,DOGE:5000004');
        // Insertion order must not reach the bytes, or an honest leader and an honest
        // follower could build the same map into two different signatures.
        expect(ah.encodeAdmitBlocks({ BTC: 900004, DOGE: 5000004 }))
            .to.equal(ah.encodeAdmitBlocks({ DOGE: 5000004, BTC: 900004 }));
    });

    it('defeats the adversarial split: CODE:1,X:23 is not CODE:12,X:3', () => {
        // This is the map form of the failure attest_response_canonical.js documents,
        // where meta="X" effective=1234 and meta="X1" effective=234 concatenate alike.
        let a = ah.encodeAdmitBlocks({ BTC: 1,  LTC: 23 });
        let b = ah.encodeAdmitBlocks({ BTC: 12, LTC: 3  });
        expect(a).to.equal('BTC:1,LTC:23');
        expect(b).to.equal('BTC:12,LTC:3');
        expect(a).to.not.equal(b);
        expect(ah.decodeAdmitBlocks(a)).to.deep.equal({ BTC: 1,  LTC: 23 });
        expect(ah.decodeAdmitBlocks(b)).to.deep.equal({ BTC: 12, LTC: 3  });
    });

    it('round-trips every map in a generated corpus, and no two maps share bytes', () => {
        let seen = new Map();
        let chains = ['BTC', 'LTC', 'DOGE'];
        for(let mask = 1; mask < 8; mask++){
            for(let h of [0, 1, 3, 12, 23, 120, 900004, 9007199254740989]){
                let map = {};
                chains.forEach((c, i) => { if(mask & (1 << i)) map[c] = h + i; });
                let bytes = ah.encodeAdmitBlocks(map);
                expect(ah.decodeAdmitBlocks(bytes), bytes).to.deep.equal(map);
                let key = JSON.stringify(Object.keys(map).sort().map(k => [k, map[k]]));
                if(seen.has(bytes)) expect(seen.get(bytes), 'collision on ' + bytes).to.equal(key);
                seen.set(bytes, key);
            }
        }
        expect(seen.size).to.equal(7 * 8);
    });

    it('refuses a non-canonical height spelling, which is a value no verifier could re-derive', () => {
        for(let bad of ['0120', '+4', ' 4', '-1', '4.0', '1e3', '', null, undefined, 1.5, -1, NaN])
            expect(() => ah.encodeAdmitBlocks({ BTC: bad }), JSON.stringify(bad))
                .to.throw(/canonically spelled/);
        // A safe-integer boundary: past it the digits are already gone.
        expect(() => ah.encodeAdmitBlocks({ BTC: 9007199254740993 })).to.throw(/canonically spelled/);
    });

    it('refuses an empty map rather than encoding it as empty bytes', () => {
        // Empty bytes after the '|' would be indistinguishable from a legacy row that
        // carries no field at all, which is a second reading of the same canonical.
        expect(() => ah.encodeAdmitBlocks({})).to.throw(/EMPTY admission map/);
    });

    it('refuses a chain code outside the closed vocabulary the encoding rests on', () => {
        expect(() => ah.encodeAdmitBlocks({ 'B:TC': 1 })).to.throw(/closed vocabulary/);
        expect(() => ah.encodeAdmitBlocks({ 'B,TC': 1 })).to.throw(/closed vocabulary/);
        expect(() => ah.encodeAdmitBlocks({ 'btc': 1 })).to.throw(/closed vocabulary/);
    });

    it('the decoder rejects every non-canonical variant of a valid map', () => {
        expect(ah.decodeAdmitBlocks('BTC:900004,DOGE:5000004')).to.deep.equal({ BTC: 900004, DOGE: 5000004 });
        for(let bad of ['DOGE:5000004,BTC:900004',   // out of ASCII order
                        'BTC:0900004',               // leading zero
                        'BTC:900004,BTC:900005',     // repeated code
                        'BTC:900004,',               // trailing separator
                        ',BTC:900004',
                        'BTC:-1',
                        'BTC:',
                        'BTC',
                        'btc:1',
                        ''])
            expect(ah.decodeAdmitBlocks(bad), JSON.stringify(bad)).to.equal(null);
    });
});

describe('admission_height: the row helpers', () => {

    it('reads the map back from whichever admission columns a row actually sets', () => {
        expect(ah.rowAdmitBlocks({ admit_block_btc: 900004, admit_block_doge: 5000004 }))
            .to.deep.equal({ BTC: 900004, DOGE: 5000004 });
    });

    it('a row with no admission column at all is a LEGACY row, which is null and not an empty map', () => {
        expect(ah.rowAdmitBlocks({ effective_time: 123 })).to.equal(null);
        expect(ah.rowAdmitBlocks({ admit_block_btc: null, admit_block_ltc: null })).to.equal(null);
    });

    it('refuses a row whose in-memory map and stored columns disagree', () => {
        // A leader that could show followers one map and verifiers another would collect
        // a quorum over bytes neither side can rebuild.
        expect(() => ah.rowAdmitBlocks({ admit_blocks: { BTC: 5 }, admit_block_btc: 6 }))
            .to.throw(/disagrees with its stored admission columns/);
        expect(ah.rowAdmitBlocks({ admit_blocks: { BTC: 6 }, admit_block_btc: 6 })).to.deep.equal({ BTC: 6 });
    });

    it('writes every federation column, naming the chains in the map and NULLing the rest', () => {
        expect(ah.admitBlocksToColumns({ BTC: 900004 }))
            .to.deep.equal({ admit_block_btc: 900004, admit_block_ltc: null, admit_block_doge: null });
    });
});

describe('admission_height: the era gate, INERT', () => {
    const REGTEST = 'regtest';
    let armed;

    // Forced inert rather than trusted inert: the assertions below are about the branch a
    // node takes when its activation key is null, and a process launched with the regtest
    // key set would otherwise take the other one and pass vacuously.
    before(() => { armed = withAdmissionActivation(null); });
    after(() => { armed.restore(); });

    it('is keyed on the ROW\'s own BTC block through the producer activation map', () => {
        // An unset regtest key is INERT at every height, including height 0.
        expect(armed.act.isMirrorAdmissionProducerActive('BTC', REGTEST, 1000)).to.equal(false);
        expect(armed.ah.isAdmissionEra(REGTEST, 0)).to.equal(false);
        expect(armed.ah.isAdmissionEra(REGTEST, 99999999)).to.equal(false);
        // mainnet and testnet are null in this train, so they are INERT at every height,
        // including the height-0 case a bare `height >= MAP[key]` would arm.
        expect(armed.ah.isAdmissionEra('mainnet', 0)).to.equal(false);
        expect(armed.ah.isAdmissionEra('mainnet', 99999999)).to.equal(false);
        expect(armed.ah.isAdmissionEra('testnet', 0)).to.equal(false);
        // An unknown network is INERT, never armed.
        expect(armed.ah.isAdmissionEra('not-a-network', 99999999)).to.equal(false);
    });

    it('builds NO field below the activation, so the legacy bytes are unchanged', () => {
        expect(armed.ah.admissionCanonicalField('XTEST', 'mainnet', 1000, null)).to.equal('');
        expect(armed.ah.admissionCanonicalField('XTEST', 'mainnet', 1000, undefined)).to.equal('');
        expect(armed.ah.admissionCanonicalField('XTEST', REGTEST, 1000, null)).to.equal('');
    });

    it('refuses to build an ADMISSION canonical for a legacy-era row', () => {
        expect(() => armed.ah.admissionCanonicalField('XTEST', 'mainnet', 1000, { BTC: 1004 }))
            .to.throw(/refusing to build an admission-era canonical/);
        expect(() => armed.ah.admissionCanonicalField('XTEST', REGTEST, 1000, { BTC: 1004 }))
            .to.throw(/refusing to build an admission-era canonical/);
    });
});

describe('admission_height: the era gate, ARMED at a regtest height', () => {
    const REGTEST = 'regtest';
    let armed;

    before(() => { armed = withAdmissionActivation(ERA_AT); });
    after(() => { armed.restore(); });

    it('arms at the height it was given and NOT below it', () => {
        expect(armed.ah.isAdmissionEra(REGTEST, ERA_AT)).to.equal(true);
        expect(armed.ah.isAdmissionEra(REGTEST, ERA_AT + 1)).to.equal(true);
        expect(armed.ah.isAdmissionEra(REGTEST, ERA_AT - 1)).to.equal(false);
        // The arming is per (coin, network): mainnet and testnet stay inert in the SAME
        // process, which is the mixed-fleet case a flag day has to survive.
        expect(armed.ah.isAdmissionEra('mainnet', ERA_AT)).to.equal(false);
        expect(armed.ah.isAdmissionEra('testnet', ERA_AT)).to.equal(false);
    });

    it('refuses to build a LEGACY canonical for an admission-era row', () => {
        // The branch under test is the refusal, and it is the one that strands a row: a
        // modern row signed over legacy bytes reproduces for no verifier in the fleet.
        expect(() => armed.ah.admissionCanonicalField('XTEST', REGTEST, ERA_AT, null))
            .to.throw(/refusing to build a legacy canonical/);
        expect(() => armed.ah.admissionCanonicalField('XTEST', REGTEST, ERA_AT, undefined))
            .to.throw(/refusing to build a legacy canonical/);
    });

    it('appends the field after a single pipe when the era is active', () => {
        expect(armed.ah.admissionCanonicalField('XTEST', REGTEST, ERA_AT, { BTC: 1004, DOGE: 2004 }))
            .to.equal('|BTC:1004,DOGE:2004');
        // And a row BELOW the activation in the same armed process still gets no field.
        expect(armed.ah.admissionCanonicalField('XTEST', REGTEST, ERA_AT - 1, null)).to.equal('');
    });
});

describe('XChainHub._resolveAdmissionTip: the DECODER tip, ungated by lag', () => {
    const http = require('http');
    const XChainHub = require('../../src/XChainHub.js');

    let server, url, reply;

    before((done) => {
        // A real indexer-shaped JSON-RPC endpoint rather than a stubbed axios, so the
        // assertion about which FIELD is read survives a refactor of how it is fetched.
        server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: reply }));
            });
        });
        server.listen(0, '127.0.0.1', () => {
            url = 'http://127.0.0.1:' + server.address().port;
            done();
        });
    });
    after((done) => { server.close(done); });

    // The method reads nothing off `this` but _resolveIndexerUrl and _admissionTipSeen.
    function hubStub(){
        return {
            _resolveIndexerUrl:  async () => url,
            _admissionTipSeen:   new Map(),
            _resolveAdmissionTip: XChainHub.prototype._resolveAdmissionTip,
            _admissionTipFresh:   XChainHub.prototype._admissionTipFresh,
        };
    }

    it('reads decoder_block and NOT the committed block_index', async () => {
        reply = { block_index: 1000, decoder_block: 1200, lag: 200 };
        expect(await hubStub()._resolveAdmissionTip('BTC')).to.equal(1200);
    });

    it('accepts a tip whose lag is far past MAX_INDEXER_LAG_BLOCKS', async () => {
        // The single easiest mistake in this row. A barriered indexer IS a high-lag
        // indexer, so a lag gate here would refuse the reading in exactly the case
        // admission by height exists to serve. The committed-tip path keeps that gate;
        // this one must not have it.
        reply = { block_index: 1000, decoder_block: 9999, lag: 8999 };
        expect(await hubStub()._resolveAdmissionTip('BTC')).to.equal(9999);
        // Same reading with MAX_INDEXER_LAG_BLOCKS explicitly set low.
        let prev = process.env.MAX_INDEXER_LAG_BLOCKS;
        process.env.MAX_INDEXER_LAG_BLOCKS = '5';
        try { expect(await hubStub()._resolveAdmissionTip('BTC')).to.equal(9999); }
        finally { if(prev === undefined) delete process.env.MAX_INDEXER_LAG_BLOCKS; else process.env.MAX_INDEXER_LAG_BLOCKS = prev; }
    });

    it('refuses rather than falling back to the committed tip when decoder_block is absent', async () => {
        // A v6 indexer, or one that has not decoded a block yet. Falling back to
        // block_index here would reintroduce the circularity the design removes.
        reply = { block_index: 1000, decoder_block: null, lag: null };
        expect(await hubStub()._resolveAdmissionTip('BTC')).to.equal(null);
        reply = { block_index: 1000 };
        expect(await hubStub()._resolveAdmissionTip('BTC')).to.equal(null);
    });

    it('refuses an unusable chain code without calling out', async () => {
        reply = { decoder_block: 5 };
        expect(await hubStub()._resolveAdmissionTip('not a chain')).to.equal(null);
    });
});

describe('XChainHub._admissionTipFresh: per chain, and a refusal is not a guess', () => {
    const XChainHub = require('../../src/XChainHub.js');

    function hubStub(){
        return { _admissionTipSeen: new Map(), _admissionTipFresh: XChainHub.prototype._admissionTipFresh };
    }

    it('takes a first sighting, and takes any height that has ADVANCED', () => {
        let h = hubStub();
        expect(h._admissionTipFresh('BTC', 1000)).to.equal(true);
        expect(h._admissionTipFresh('BTC', 1001)).to.equal(true);
    });

    it('refuses a tip that has not advanced past the chain\'s own stall window', () => {
        let h = hubStub();
        expect(h._admissionTipFresh('DOGE', 500)).to.equal(true);
        // Backdate the observation past DOGE's window (6 blocks of 60 s = 360 s) but
        // well inside BTC's (6 blocks of 600 s = 3600 s).
        h._admissionTipSeen.set('DOGE', { height: 500, atMs: Date.now() - 400 * 1000 });
        expect(h._admissionTipFresh('DOGE', 500)).to.equal(false);

        let b = hubStub();
        expect(b._admissionTipFresh('BTC', 500)).to.equal(true);
        b._admissionTipSeen.set('BTC', { height: 500, atMs: Date.now() - 400 * 1000 });
        // THE POINT: the same 400 s of no movement is stale on DOGE and fresh on BTC.
        // A flat window would call one of these wrong.
        expect(b._admissionTipFresh('BTC', 500)).to.equal(true);
        b._admissionTipSeen.set('BTC', { height: 500, atMs: Date.now() - 4000 * 1000 });
        expect(b._admissionTipFresh('BTC', 500)).to.equal(false);
    });

    it('a frozen chain stays refused, and an advance clears it', () => {
        let h = hubStub();
        h._admissionTipSeen.set('DOGE', { height: 500, atMs: Date.now() - 4000 * 1000 });
        expect(h._admissionTipFresh('DOGE', 500)).to.equal(false);
        expect(h._admissionTipFresh('DOGE', 501)).to.equal(true);
    });
});

describe('admission_height: the engines\' canonical builders carry the same gate', () => {
    const REGTEST = 'regtest';

    function matchRow(extra){
        return Object.assign({
            match_id: 'm1', snapshot_block: 1000, network: REGTEST,
            a_chain: 'BTC', a_action_index: 1, a_tick: 'TEST', a_amount: '1', a_ownership: '1', a_payout_addr: 'a',
            b_chain: 'DOGE', b_action_index: 2, b_tick: 'TEST', b_amount: '1', b_ownership: '1', b_payout_addr: 'b',
            effective_time: 1700000000
        }, extra || {});
    }
    function policyRow(extra){
        return Object.assign({
            snapshot_id: 's1', snapshot_block: 1000, origin_chain: 'BTC', tick: 'TEST',
            policy_seq: 1, origin_block: 900, policy_hash: 'h', effective_time: 1700000000, network: REGTEST
        }, extra || {});
    }

    describe('below the activation', () => {
        let inert;
        before(() => { inert = withAdmissionActivation(null); });
        after(() => { inert.restore(); });

        it('a LEGACY-era match canonical is byte-identical to what it was before this field existed', () => {
            // mainnet is INERT in this train at every height, so this is the from-genesis
            // replay case: no separator, no field, nothing appended.
            let r = matchRow({ network: 'mainnet' });
            let raw = inert.DEX.call({}, r, 0);
            expect(raw).to.not.match(/BTC:/);
            expect(raw.split('|').pop()).to.equal('0');   // b_filled_before, the old last field
        });

        it('the match builder refuses an admission map on a legacy-era row', () => {
            expect(() => inert.DEX.call({}, matchRow({ network: 'mainnet', admit_blocks: { BTC: 1004, DOGE: 2004 } }), 0))
                .to.throw(/CrossChainDex.*refusing to build an admission-era canonical/);
        });

        it('the policy builder refuses an admission map on a legacy-era row', () => {
            expect(() => inert.BRIDGE.call({}, policyRow({ network: 'mainnet', admit_block_btc: 1004 }), 0))
                .to.throw(/CrossChainPolicy.*refusing to build an admission-era canonical/);
        });
    });

    describe('at and above the activation', () => {
        let armed;
        before(() => { armed = withAdmissionActivation(ERA_AT); });
        after(() => { armed.restore(); });

        it('the match builder refuses to build LEGACY bytes for an admission-era row', () => {
            expect(() => armed.DEX.call({}, matchRow(), 0))
                .to.throw(/CrossChainDex.*refusing to build a legacy canonical/);
        });

        it('an admission-era match canonical ends with the ASCII-ordered map', () => {
            let raw = armed.DEX.call({}, matchRow({ admit_block_btc: 1004, admit_block_doge: 2004 }), 0);
            expect(raw.endsWith('|BTC:1004,DOGE:2004')).to.equal(true);
            // And the map is the LAST thing appended, so two rows differing only in their
            // admission heights differ in their signed bytes.
            let other = armed.DEX.call({}, matchRow({ admit_block_btc: 1005, admit_block_doge: 2004 }), 0);
            expect(other).to.not.equal(raw);
        });

        it('an admission-era policy canonical carries every federation chain it was stamped with', () => {
            let raw = armed.BRIDGE.call({}, policyRow({ admit_block_btc: 1004, admit_block_ltc: 3004, admit_block_doge: 2004 }), 0);
            expect(raw.endsWith('|BTC:1004,DOGE:2004,LTC:3004')).to.equal(true);
        });

        it('a row BELOW the activation in the same armed process keeps the legacy bytes', () => {
            // The mixed case a flag day actually produces, and the one a process-wide arming
            // switch could never drive: both eras alive in one run, keyed on the row. The
            // assertion is byte EQUALITY against a builder that never heard of the
            // activation, because "no field appended" is the whole legacy guarantee.
            let row  = matchRow({ snapshot_block: ERA_AT - 1 });
            let raw  = armed.DEX.call({}, row, 0);
            let inert = withAdmissionActivation(null);
            try { expect(raw).to.equal(inert.DEX.call({}, row, 0)); }
            finally { inert.restore(); }
            expect(raw).to.not.match(/\|[A-Z]{3,4}:\d+(,[A-Z]{3,4}:\d+)*$/);
        });
    });
});
