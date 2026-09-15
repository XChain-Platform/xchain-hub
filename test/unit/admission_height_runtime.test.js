'use strict';

const { expect } = require('chai');

const ERA_MODULES = [
    '../../src/mirror_admission_activation.js',
    '../../src/lib/admission_height.js',
    '../../src/cross_chain/dex_engine.js',
    '../../src/cross_chain/bridge_engine.js'
];
const ERA_AT = 1000;
const http = require('http');
const XChainHub = require('../../src/XChainHub.js');

let server, url, reply;

// The method reads nothing off `this` but _resolveIndexerUrl and _admissionTipSeen.
function admissionHubStub(){
    return {
        _resolveIndexerUrl:  async () => url,
        _admissionTipSeen:   new Map(),
        resolveAdmissionTip: XChainHub.prototype.resolveAdmissionTip,
        admissionTipFresh:   XChainHub.prototype.admissionTipFresh,
    };
}

function freshnessHubStub(){
    return { _admissionTipSeen: new Map(), admissionTipFresh: XChainHub.prototype.admissionTipFresh };
}

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
        DEX:    require('../../src/cross_chain/dex_engine.js').prototype._canonicalMatch,
        BRIDGE: require('../../src/cross_chain/bridge_engine.js').prototype._canonicalMatch,
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

describe('XChainHub.resolveAdmissionTip: the DECODER tip, ungated by lag', () => {
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

    it('reads decoder_block and NOT the committed block_index', async () => {
        reply = { block_index: 1000, decoder_block: 1200, lag: 200 };
        expect(await admissionHubStub().resolveAdmissionTip('BTC')).to.equal(1200);
    });

    it('accepts a tip whose lag is far past MAX_INDEXER_LAG_BLOCKS', async () => {
        // The single easiest mistake in this row. A barriered indexer IS a high-lag
        // indexer, so a lag gate here would refuse the reading in exactly the case
        // admission by height exists to serve. The committed-tip path keeps that gate;
        // this one must not have it.
        reply = { block_index: 1000, decoder_block: 9999, lag: 8999 };
        expect(await admissionHubStub().resolveAdmissionTip('BTC')).to.equal(9999);
        // Same reading with MAX_INDEXER_LAG_BLOCKS explicitly set low.
        let prev = process.env.MAX_INDEXER_LAG_BLOCKS;
        process.env.MAX_INDEXER_LAG_BLOCKS = '5';
        try { expect(await admissionHubStub().resolveAdmissionTip('BTC')).to.equal(9999); }
        finally { if(prev === undefined) delete process.env.MAX_INDEXER_LAG_BLOCKS; else process.env.MAX_INDEXER_LAG_BLOCKS = prev; }
    });

    it('refuses rather than falling back to the committed tip when decoder_block is absent', async () => {
        // A v6 indexer, or one that has not decoded a block yet. Falling back to
        // block_index here would reintroduce the circularity the design removes.
        reply = { block_index: 1000, decoder_block: null, lag: null };
        expect(await admissionHubStub().resolveAdmissionTip('BTC')).to.equal(null);
        reply = { block_index: 1000 };
        expect(await admissionHubStub().resolveAdmissionTip('BTC')).to.equal(null);
    });

    it('refuses an unusable chain code without calling out', async () => {
        reply = { decoder_block: 5 };
        expect(await admissionHubStub().resolveAdmissionTip('not a chain')).to.equal(null);
    });
});

describe('XChainHub.admissionTipFresh: per chain, and a refusal is not a guess', () => {
    it('takes a first sighting, and takes any height that has ADVANCED', () => {
        let h = freshnessHubStub();
        expect(h.admissionTipFresh('BTC', 1000)).to.equal(true);
        expect(h.admissionTipFresh('BTC', 1001)).to.equal(true);
    });

    it('refuses a tip that has not advanced past the chain\'s own stall window', () => {
        let h = freshnessHubStub();
        expect(h.admissionTipFresh('DOGE', 500)).to.equal(true);
        // Backdate the observation past DOGE's window (6 blocks of 60 s = 360 s) but
        // well inside BTC's (6 blocks of 600 s = 3600 s).
        h._admissionTipSeen.set('DOGE', { height: 500, atMs: Date.now() - 400 * 1000 });
        expect(h.admissionTipFresh('DOGE', 500)).to.equal(false);

        let b = freshnessHubStub();
        expect(b.admissionTipFresh('BTC', 500)).to.equal(true);
        b._admissionTipSeen.set('BTC', { height: 500, atMs: Date.now() - 400 * 1000 });
        // THE POINT: the same 400 s of no movement is stale on DOGE and fresh on BTC.
        // A flat window would call one of these wrong.
        expect(b.admissionTipFresh('BTC', 500)).to.equal(true);
        b._admissionTipSeen.set('BTC', { height: 500, atMs: Date.now() - 4000 * 1000 });
        expect(b.admissionTipFresh('BTC', 500)).to.equal(false);
    });

    it('a frozen chain stays refused, and an advance clears it', () => {
        let h = freshnessHubStub();
        h._admissionTipSeen.set('DOGE', { height: 500, atMs: Date.now() - 4000 * 1000 });
        expect(h.admissionTipFresh('DOGE', 500)).to.equal(false);
        expect(h.admissionTipFresh('DOGE', 501)).to.equal(true);
    });
});

function registerArmedCanonicalBuilderSuite() {
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
            // activation, because "no field appended" is the whole pre-admission guarantee.
            let row  = matchRow({ snapshot_block: ERA_AT - 1 });
            let raw  = armed.DEX.call({}, row, 0);
            let inert = withAdmissionActivation(null);
            try { expect(raw).to.equal(inert.DEX.call({}, row, 0)); }
            finally { inert.restore(); }
            expect(raw).to.not.match(/\|[A-Z]{3,4}:\d+(,[A-Z]{3,4}:\d+)*$/);
        });
    });
}

function registerInertCanonicalBuilderSuite() {
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
}

describe('admission_height: the engines\' canonical builders carry the same gate', () => {
    registerInertCanonicalBuilderSuite();

    registerArmedCanonicalBuilderSuite();
});
