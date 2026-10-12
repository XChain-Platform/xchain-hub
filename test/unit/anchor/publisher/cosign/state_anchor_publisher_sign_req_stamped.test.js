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
//
// StateAnchorPublisher: handleAttestSignReq refuses to co-sign the XANCPUB
// publisher attestation for a bundle whose rows already carry an anchor_txid,
// so a second publisher cannot collect a reward for an anchor that landed.
// The mesh harness lives in test/helpers/anchor_mesh.js.

const { expect }            = require('chai');
const arMod                 = require('../../../../../src/consensus/gates/anchor_reward_gate.js');
const { buildMesh, v0Order, registerMeshHooks } = require('../../../../helpers/anchor_mesh.js');

describe('StateAnchorPublisher', function () {
    registerMeshHooks();

    describe('handleAttestSignReq on already-stamped rows', function () {
        beforeEach(function () { arMod.ANCHOR_REWARD_ACTIVATION.regtest = 0; });

        function setup() {
            let bus       = buildMesh(3, { btcBlock: 100 });
            let order     = v0Order(bus);
            let publisher = order[0];
            let follower  = order[1];
            let row       = publisher.db.checkpoints[0];
            let cp        = publisher.pub.cpFromRow(row);
            let canonical = publisher.pub.attestationCanonical(cp, publisher.pubkey);
            let sent      = [];
            follower.pub.peerManager.broadcast = (type, data) => { sent.push({ type, data }); };
            let req = { data: {
                network: row.network, snapshot_block: Number(row.snapshot_block),
                publisher: publisher.pubkey, sig_pubkey: publisher.pubkey,
                sections: [{ chain: row.chain, block_index: row.block_index, checkpoint_seq: row.checkpoint_seq }],
                body: publisher.pub.buildV7Payload([row], publisher.pubkey, []),
                sig: publisher.identity.sign(canonical)
            }};
            return { follower, req, sent };
        }

        it('co-signs an unstamped bundle (control)', async function () {
            let { follower, req, sent } = setup();
            await follower.pub.handleAttestSignReq(req);
            expect(sent.length, 'one XANCPUB_SIGN broadcast').to.equal(1);
        });

        it('refuses to co-sign once the follower rows carry an anchor_txid', async function () {
            let { follower, req, sent } = setup();
            for (let r of follower.db.checkpoints) r.anchor_txid = 'cc'.repeat(32);
            await follower.pub.handleAttestSignReq(req);
            expect(sent.length, 'no co-sign on a stamped row').to.equal(0);
        });
    });
});
