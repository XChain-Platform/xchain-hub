'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// Two hubs read different BTC tips, so each pins a different admission map. The
// proposer signs over its own map; a follower rebuilding that canonical from its own
// pinned map can never verify it. These tests drive the canonical seam with a divergent
// tip: the map must travel on the wire, be bounded against the follower's own tip, and
// be the map the follower rebuilds from.

const { expect }        = require('chai');
const ValidatorIdentity = require('../../../src/validators/identity.js');

const ADMIT_AT = 799000;
const RID      = 'cd'.repeat(16);
const BODY     = Buffer.from('agreed-body');
const META     = 'tag=1';
const NETWORK  = 'regtest';

function armed(fn) {
    const mods = [
        '../../../src/consensus/gates/mirror_admission_gate.js',
        '../../../src/lib/admission_height.js',
        '../../../src/attestation/consensus/canonical.js'
    ].map(m => require.resolve(m));
    const saved    = mods.map(p => [p, require.cache[p]]);
    const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    for (const p of mods) delete require.cache[p];
    process.env.XC_MIRROR_ADMISSION_ACTIVATION = String(ADMIT_AT);
    try {
        return fn({
            canonical: require('../../../src/attestation/consensus/canonical.js'),
            ah:        require('../../../src/lib/admission_height.js')
        });
    } finally {
        for (const [p, mod] of saved) {
            if (mod === undefined) delete require.cache[p]; else require.cache[p] = mod;
        }
        if (savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
    }
}

function makeHub(canonical, tip, blockIndex) {
    const identity = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
    const hub = {
        network: NETWORK,
        resolveAdmissionTips: async () => ({ BTC: tip })
    };
    const pending = new Map();
    pending.set(RID, { request: { block_index: blockIndex }, admitBlocks: { BTC: tip + 4 } });
    return Object.assign(Object.create(canonical), { hub, identity, pending, isMirrorEra: () => false });
}

const BLOCK = ADMIT_AT + 10;

describe('attestation admission map on the wire, signature across divergent tips', function () {

    it('a follower pinned to its own map cannot verify a proposer whose tip differs', function () {
        armed(({ canonical }) => {
            const leader   = makeHub(canonical, 1000, BLOCK);
            const follower = makeHub(canonical, 1002, BLOCK);
            const sig = leader.signCanonical(RID, 'http_get', BODY, 'ok', META, BLOCK, null);
            const local = follower.buildCanonical(RID, 'http_get', BODY, 'ok', META, BLOCK, null);
            expect(ValidatorIdentity.verify(local.toString('utf8'), sig, leader.identity.getPubkeyHex())).to.equal(false);
        });
    });

    it('rebuilding from the wire map verifies the proposer signature', async function () {
        await armed(async ({ canonical }) => {
            const leader   = makeHub(canonical, 1000, BLOCK);
            const follower = makeHub(canonical, 1002, BLOCK);
            const sig = leader.signCanonical(RID, 'http_get', BODY, 'ok', META, BLOCK, null);
            const wire = JSON.parse(JSON.stringify(leader.admitWireFields(leader.pending.get(RID))));
            expect(wire).to.deep.equal({ admit_blocks: 'BTC:1004' });

            const read = await follower.readWireAdmitBlocks(follower.pending.get(RID), wire);
            expect(read).to.deep.equal({ ok: true, admitBlocks: { BTC: 1004 } });
            const rebuilt = follower.buildCanonical(RID, 'http_get', BODY, 'ok', META, BLOCK, null, read.admitBlocks);
            expect(ValidatorIdentity.verify(rebuilt.toString('utf8'), sig, leader.identity.getPubkeyHex())).to.equal(true);
        });
    });

});

describe('attestation admission map on the wire, follower refusals', function () {
    it('refuses a wire map outside the follower bound against its own tip', async function () {
        await armed(async ({ canonical }) => {
            const follower = makeHub(canonical, 1000, BLOCK);
            const pending  = follower.pending.get(RID);
            for (const bad of ['BTC:1000', 'BTC:5000', 'BTC:900']) {
                const read = await follower.readWireAdmitBlocks(pending, { admit_blocks: bad });
                expect(read.ok, bad).to.equal(false);
                expect(read.reason, bad).to.match(/outside \[/);
            }
        });
    });

    it('refuses a missing, malformed, extra-chain or unresolvable map in the admission era', async function () {
        await armed(async ({ canonical }) => {
            const follower = makeHub(canonical, 1000, BLOCK);
            const pending  = follower.pending.get(RID);
            expect((await follower.readWireAdmitBlocks(pending, {})).reason).to.match(/carries no admission map/);
            expect((await follower.readWireAdmitBlocks(pending, { admit_blocks: 'BTC:01004' })).reason).to.match(/canonically spelled/);
            expect((await follower.readWireAdmitBlocks(pending, { admit_blocks: 'BTC:1004,LTC:1' })).reason).to.match(/does not read this row/);
            follower.hub.resolveAdmissionTips = async () => ({ BTC: null });
            expect((await follower.readWireAdmitBlocks(pending, { admit_blocks: 'BTC:1004' })).ok).to.equal(false);
        });
    });

    it('a legacy-era request carries no map and refuses one', async function () {
        await armed(async ({ canonical }) => {
            const legacyBlock = ADMIT_AT - 1;
            const leader   = makeHub(canonical, 1000, legacyBlock);
            const follower = makeHub(canonical, 1002, legacyBlock);
            leader.pending.get(RID).admitBlocks = null;
            expect(leader.admitWireFields(leader.pending.get(RID))).to.deep.equal({});
            expect(await follower.readWireAdmitBlocks(follower.pending.get(RID), {})).to.deep.equal({ ok: true, admitBlocks: null });
            const read = await follower.readWireAdmitBlocks(follower.pending.get(RID), { admit_blocks: 'BTC:1004' });
            expect(read.ok).to.equal(false);
            expect(read.reason).to.match(/legacy-era request carries/);
        });
    });
});
