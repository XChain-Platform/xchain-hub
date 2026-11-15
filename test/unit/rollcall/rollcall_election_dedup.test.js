'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const election = require('../../../src/rollcall/round/election.js');
const StateAnchorPublisher = require('../../../src/anchor/publisher.js');

const EPOCH = 30;
const KEYS = ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)];

function context(rows, anchorRail) {
    return {
        network: 'regtest',
        electionKey: election.electionKey,
        electionToleranceBlocks: 3,
        capabilitySnapshot: { getWeightSnapshot: async () => ({ validators: rows }) },
        hub: anchorRail ? { stateAnchorPublisher: { resolveCapabilitySet: async () => rows } } : {}
    };
}

async function assertDeduped(anchorRail) {
    const rows = KEYS.map((pubkey, i) => ({ pubkey, source: 's' + i }));
    rows.push({ pubkey: KEYS[0].toUpperCase(), source: 'extra' });
    const ctx = context(rows, anchorRail);
    const order = await election.electionOrder.call(ctx, EPOCH);
    const expected = StateAnchorPublisher.hashOrder('XROLLCALL|regtest|' + EPOCH, KEYS);
    const raw = StateAnchorPublisher.hashOrder('XROLLCALL|regtest|' + EPOCH,
        rows.map(row => row.pubkey.toLowerCase()));
    expect(order).to.deep.equal(expected);
    expect(order).to.have.length(KEYS.length);
    expect(order[0]).to.equal(raw[0]);
    const rank = order.length - 1;
    expect(election.rankUnlocked.call(ctx, order, order[rank], rank * 3)).to.equal(true);
    expect(election.rankUnlocked.call(ctx, order, order[rank], rank * 3 - 1)).to.equal(false);
}

describe('rollcall election dedupe', function () {
    it('dedupes source-keyed rows borrowed from the anchor rail', async function () {
        await assertDeduped(true);
    });

    it('dedupes source-keyed rows from the snapshot fallback', async function () {
        await assertDeduped(false);
    });
});
