'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const fs         = require('fs');
const path       = require('path');
const { expect } = require('chai');
const { resolveRegtestSnapshotSeams } = require('../../../src/lib/regtest_snapshot_seams.js');
const { createMockHub } = require('../../helpers/mockHub');

const SRC = path.join(__dirname, '../../../src');
const ENV_KEYS = ['XDEX_SNAPSHOT_BLOCK', 'XDEX_SEED_LOCAL_VALIDATOR'];
const CLOSED_NETWORKS = ['mainnet', 'testnet', '', undefined, 'REGTEST', 'regtest '];
const ENGINES = {
    StateCheckpointEngine: '../../../src/anchor/checkpoint_engine.js',
    CrossChainDexEngine:   '../../../src/cross_chain/dex_engine.js',
    CrossChainCallEngine:  '../../../src/cross_chain/call_engine.js',
    CrossChainBridgeEngine: '../../../src/cross_chain/bridge_engine.js',
    ListShareEngine:       '../../../src/cross_chain/list_share_engine.js'
};

function jsFilesUnder(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((ent) => {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) return jsFilesUnder(p);
        return ent.name.endsWith('.js') ? [p] : [];
    });
}

describe('regtest snapshot seams: the shared resolver', function () {
    const both = { XDEX_SNAPSHOT_BLOCK: '42', XDEX_SEED_LOCAL_VALIDATOR: '1' };

    it('fails closed to NaN and false on every network but exact regtest', function () {
        for (const net of CLOSED_NETWORKS) {
            const s = resolveRegtestSnapshotSeams(net, { XDEX_SNAPSHOT_BLOCK: '42', XDEX_SEED_LOCAL_VALIDATOR: true }, both);
            expect(Number.isNaN(s.snapshotBlockOverride), String(net)).to.equal(true);
            expect(s.seedLocalValidator, String(net)).to.equal(false);
        }
    });

    it('honours both seams on regtest, env before the configs row', function () {
        const s = resolveRegtestSnapshotSeams('regtest', { XDEX_SNAPSHOT_BLOCK: '7' }, both);
        expect(s.snapshotBlockOverride).to.equal(42);
        expect(s.seedLocalValidator).to.equal(true);
        expect(resolveRegtestSnapshotSeams('regtest', { XDEX_SNAPSHOT_BLOCK: '7' }, {}).snapshotBlockOverride).to.equal(7);
    });

    it('accepts only the forms it always accepted for the seeded validator', function () {
        expect(resolveRegtestSnapshotSeams('regtest', {}, { XDEX_SEED_LOCAL_VALIDATOR: 'true' }).seedLocalValidator).to.equal(false);
        expect(resolveRegtestSnapshotSeams('regtest', { XDEX_SEED_LOCAL_VALIDATOR: true }, {}).seedLocalValidator).to.equal(true);
        expect(resolveRegtestSnapshotSeams('regtest', { XDEX_SEED_LOCAL_VALIDATOR: '1' }, {}).seedLocalValidator).to.equal(true);
        const unset = resolveRegtestSnapshotSeams('regtest', undefined, {});
        expect(Number.isNaN(unset.snapshotBlockOverride)).to.equal(true);
        expect(unset.seedLocalValidator).to.equal(false);
    });

    it('is the only place under src that reads either seam', function () {
        const readers = jsFilesUnder(SRC).filter((f) => /XDEX_SEED_LOCAL_VALIDATOR ===|XDEX_SNAPSHOT_BLOCK \|\|/.test(fs.readFileSync(f, 'utf8')));
        expect(readers.map((f) => path.relative(SRC, f))).to.deep.equal(['lib/regtest_snapshot_seams.js']);
    });
});

describe('regtest snapshot seams: every engine that reads them', function () {
    const saved = {};
    beforeEach(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
    afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

    function build(name, network) {
        process.env.XDEX_SNAPSHOT_BLOCK = '42';
        process.env.XDEX_SEED_LOCAL_VALIDATOR = '1';
        const Engine = require(ENGINES[name]);
        return new Engine(createMockHub({ network, p2pConfig: { XDEX_SNAPSHOT_BLOCK: '42', XDEX_SEED_LOCAL_VALIDATOR: true } }));
    }

    it('keeps both seams closed off regtest in every engine', function () {
        for (const name of Object.keys(ENGINES)) {
            for (const net of ['mainnet', 'testnet', '']) {
                const eng = build(name, net);
                expect(Number.isNaN(eng._snapshotBlockOverride), name + ' ' + net).to.equal(true);
                expect(eng._seedLocalValidator, name + ' ' + net).to.equal(false);
            }
        }
    });

    it('opens both seams on regtest in every engine', function () {
        for (const name of Object.keys(ENGINES)) {
            const eng = build(name, 'regtest');
            expect(eng._snapshotBlockOverride, name).to.equal(42);
            expect(eng._seedLocalValidator, name).to.equal(true);
        }
    });
});
