'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The reward drain walks every getanchorconfirmations page before it judges, by the
// same rules as the indexer's walk: the same cursor check, the same empty-page rule
// and the same page bound, so the hub never decides a set the indexer would defer.

const { expect }           = require('chai');
const path                 = require('path');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const { judgeAnchors }     = require('../../../../../src/anchor/anchor_proof_binding.js');
const { siblingCheckout, skipOrFail } = require('../../../../helpers/sibling_checkout.js');

const INDEXER_WALK = path.join(__dirname,
    '../../../../../../xchain-indexer/src/consensus/doge_peer_clients/anchor_proof_client/page_walk.js');

const PUB   = 'cd'.repeat(32);
const OTHER = 'ef'.repeat(32);
const TXID  = 'ab'.repeat(32);

function anchorRow(over) {
    return Object.assign({ version: 0, status: 'valid', checkpoint_network: 'regtest', publisher: PUB,
        snapshot_block: 100, action_index: 0, confirmations: 10 }, over);
}

function entry() {
    return { chain: 'BTC', network: 'regtest', txid: TXID, rewardType: 'anchor_bundle',
        roundReference: 100, snapshotBlock: 100, publisher: PUB };
}

// A sibling anchor in the same transaction that does not bind this tuple.
const SIBLING = () => anchorRow({ publisher: OTHER, action_index: 1 });

// Pages keyed by the cursor that asks for them ('first' is the cursor-less request).
const CASES = [
    { name: 'a single complete page holding the binding row', want: 'verified',
      pages: { first: { exists: true, anchors: [anchorRow()], truncated: false } } },
    { name: 'a numeric cursor that reaches the binding row on page two', want: 'verified', calls: 2,
      pages: { first: { exists: true, anchors: [SIBLING()], truncated: true, next_after_action_index: 5 },
               5: { exists: true, anchors: [anchorRow({ action_index: 6 })], truncated: false } } },
    { name: 'a digit-string cursor that reaches the binding row on page two', want: 'verified', calls: 2,
      pages: { first: { exists: true, anchors: [SIBLING()], truncated: true, next_after_action_index: '5' },
               5: { exists: true, anchors: [anchorRow({ action_index: 6 })], truncated: false } } },
    { name: 'a truncated first page with a null cursor', want: 'unknown', calls: 1,
      pages: { first: { exists: true, anchors: [SIBLING()], truncated: true, next_after_action_index: null },
               0: { exists: true, anchors: [anchorRow()], truncated: false } } },
    { name: 'a truncated first page with an empty-string cursor', want: 'unknown', calls: 1,
      pages: { first: { exists: true, anchors: [SIBLING()], truncated: true, next_after_action_index: '' },
               0: { exists: true, anchors: [anchorRow()], truncated: false } } },
    { name: 'a truncated first page with a false cursor', want: 'unknown', calls: 1,
      pages: { first: { exists: true, anchors: [SIBLING()], truncated: true, next_after_action_index: false },
               0: { exists: true, anchors: [anchorRow()], truncated: false } } },
    { name: 'a truncated first page with a negative cursor', want: 'unknown', calls: 1,
      pages: { first: { exists: true, anchors: [SIBLING()], truncated: true, next_after_action_index: -1 },
               '-1': { exists: true, anchors: [anchorRow()], truncated: false } } },
    { name: 'a truncated first page with a non-digit cursor', want: 'unknown', calls: 1,
      pages: { first: { exists: true, anchors: [SIBLING()], truncated: true, next_after_action_index: '5x' },
               5: { exists: true, anchors: [anchorRow()], truncated: false } } },
    { name: 'a cursor that does not advance', want: 'unknown', calls: 2,
      pages: { first: { exists: true, anchors: [SIBLING()], truncated: true, next_after_action_index: 5 },
               5: { exists: true, anchors: [anchorRow({ action_index: 6 })], truncated: true, next_after_action_index: 5 } } },
    { name: 'an empty later page after a page holding the binding row', want: 'verified', calls: 2,
      pages: { first: { exists: true, anchors: [anchorRow()], truncated: true, next_after_action_index: 0 },
               0: { exists: false, anchors: [], truncated: false } } },
    { name: 'a first page that does not know the txid', want: 'unknown', calls: 1,
      pages: { first: { exists: false, anchors: [], truncated: false } } },
    { name: 'a first page with no anchor rows', want: 'unknown', calls: 1,
      pages: { first: { exists: true, anchors: [], truncated: false } } },
];

function pageKey(after) { return after === null || after === undefined ? 'first' : String(after); }

function hubFor(pages) {
    let pub = new StateAnchorPublisher({ db: {}, getIdentity: () => null, hubDbBroadcaster: null });
    pub.dogeConfirmations = 6;
    pub.calls = [];
    pub.indexerCall = async (coin, method, params) => {
        pub.calls.push(params);
        let page = pages[pageKey(params.after_action_index)];
        return page === undefined ? { exists: false, anchors: [], truncated: false } : page;
    };
    return pub;
}

// The indexer's verdict for the same pages: its walk, then the shared judgeAnchors rule.
async function indexerVerdict(walk, pages, e) {
    let client = {
        fetch: async (txid, after) => {
            let page = pages[pageKey(after)];
            if (page === undefined) page = { exists: false, anchors: [], truncated: false };
            return (!page || page.error || !Array.isArray(page.anchors)) ? null : page;
        }
    };
    let anchors = await walk.walkAnchorPages(client, e.txid);
    if (anchors === null) return 'unknown';
    return judgeAnchors(anchors, { rewardType: e.rewardType, network: e.network, publisher: e.publisher,
        roundReference: Number(e.roundReference), snapshotBlock: Number(e.snapshotBlock), minConfirmations: 6 });
}

describe('reward drain: anchor page walk', function () {
    for (const c of CASES) {
        it('answers ' + c.want + ' for ' + c.name, async function () {
            let pub = hubFor(c.pages);
            expect(await pub.drainBindingVerdict(entry())).to.equal(c.want);
            if (c.calls !== undefined) expect(pub.calls.length).to.equal(c.calls);
        });
    }

    it('sends the cursor of the previous page as after_action_index', async function () {
        let pub = hubFor(CASES[1].pages);
        await pub.drainBindingVerdict(entry());
        expect(pub.calls[0]).to.not.have.property('after_action_index');
        expect(pub.calls[1].after_action_index).to.equal(5);
    });

    it('stops at the indexer page bound when every page reports truncated', async function () {
        if (!skipOrFail(this, siblingCheckout(__dirname, INDEXER_WALK), 'the indexer page-bound parity check')) return;
        const { MAX_ANCHOR_PAGES } = require(INDEXER_WALK);
        let pub = new StateAnchorPublisher({ db: {}, getIdentity: () => null, hubDbBroadcaster: null });
        pub.dogeConfirmations = 6;
        let calls = 0;
        pub.indexerCall = async (coin, method, params) => {
            calls++;
            let after = params.after_action_index === undefined ? 0 : params.after_action_index + 1;
            return { exists: true, anchors: [SIBLING()], truncated: true, next_after_action_index: after };
        };
        expect(await pub.drainBindingVerdict(entry())).to.equal('unknown');
        expect(calls).to.equal(MAX_ANCHOR_PAGES);
    });

    it('reaches the same verdict as the indexer walk on every case', async function () {
        if (!skipOrFail(this, siblingCheckout(__dirname, INDEXER_WALK), 'the indexer page-walk parity check')) return;
        const walk = require(INDEXER_WALK);
        for (const c of CASES) {
            let hub = await hubFor(c.pages).drainBindingVerdict(entry());
            expect(hub, c.name).to.equal(await indexerVerdict(walk, c.pages, entry()));
        }
    });
});
