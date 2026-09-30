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

const sinon = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

const WS_OPEN = 1;
const HubDbBroadcaster = proxyquire(
    '../../../../src/peers/hub_db_broadcaster',
    { ws: { OPEN: WS_OPEN } }
);

function makeSocket() {
    return {
        readyState: WS_OPEN,
        bufferedAmount: 0,
        send: sinon.stub(),
        close: sinon.stub(),
        on: sinon.stub()
    };
}

function signedDeletion(overrides) {
    return {
        table: 'bridge_transfers',
        source_chain: 'BTC',
        from_action_index: 2081,
        retraction_generation: 9,
        snapshot_block: 2079,
        retraction_signatures: [
            { validator_id: 'hub1', signature: 'signature-1' },
            { validator_id: 'hub2', signature: 'signature-2' }
        ],
        ...(overrides || {})
    };
}

describe('HubDbBroadcaster signed deletion replay', function () {
    let broadcaster;

    afterEach(function () {
        if (broadcaster) broadcaster.stop();
        sinon.restore();
    });

    it('replays a fenced signed deletion after ready when the original had no subscribers', async function () {
        broadcaster = new HubDbBroadcaster({});
        const deletion = signedDeletion();

        broadcaster.broadcastDeletion(deletion);

        const ws = makeSocket();
        await broadcaster.addSubscriber(ws);

        expect(ws.send.callCount).to.equal(2);
        expect(JSON.parse(ws.send.firstCall.args[0]).type).to.equal('ready');
        expect(JSON.parse(ws.send.secondCall.args[0])).to.deep.include({
            type: 'row:deleted',
            table: deletion.table,
            source_chain: deletion.source_chain,
            from_action_index: deletion.from_action_index,
            retraction_generation: deletion.retraction_generation,
            snapshot_block: deletion.snapshot_block,
            retraction_signatures: deletion.retraction_signatures
        });
    });

    it('does not replay an unfenced signed deletion', async function () {
        broadcaster = new HubDbBroadcaster({});
        const deletion = signedDeletion();
        delete deletion.retraction_generation;

        broadcaster.broadcastDeletion(deletion);

        const ws = makeSocket();
        await broadcaster.addSubscriber(ws);

        expect(ws.send.calledOnce).to.equal(true);
        expect(JSON.parse(ws.send.firstCall.args[0]).type).to.equal('ready');
    });
});
