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

// A peer's stake-backed capability claim is still accepted when the stake snapshot
// cannot be consulted (liveness first), but every such acceptance is now counted and
// logged, so an operator can see that the stake check was skipped.

const { expect }           = require('chai');
const sinon                = require('sinon');
const CapabilityGossip     = require('../../../src/hub/capability_gossip.js');
const { getLogger, getRegistry } = require('../../../src/observability');

const PUBKEY = '02' + 'aa'.repeat(32);
const CAP    = 'oracle_publish';
const METRIC = 'xchain_capability_qualification_unverified_total';

function counterValue(capability, reason) {
    let c = getRegistry().get(METRIC);
    return c ? c.get({ capability, reason }) : 0;
}

function makeHub(snapshot) {
    let hub = new CapabilityGossip();
    hub.calls = { qualification: [], enabled: [] };
    hub.capabilityRegistry = {
        getCapabilities: () => [CAP],
        setSelfTestResult: async () => {},
        setQualification: async (pubkey, cap, qualified) => { hub.calls.qualification.push(qualified); },
        setEnabled: async (pubkey, cap, on) => { hub.calls.enabled.push(on); }
    };
    if (snapshot !== undefined) hub.capabilitySnapshot = snapshot;
    return hub;
}

function activation(over) {
    return { type: 'CAPABILITY_ACTIVATED', sender: 'peerA',
        data: Object.assign({ pubkey: PUBKEY, capability: CAP, block_at: 100 }, over) };
}

// Each way the stake check can be skipped, with the hub and message that reach it.
const UNVERIFIED = [
    { reason: 'no_snapshot_service', hub: () => makeHub(), msg: activation() },
    { reason: 'no_block', hub: () => makeHub({ getSnapshot: async () => { throw new Error('not called'); } }),
      msg: activation({ block_at: null }) },
    { reason: 'snapshot_unavailable', hub: () => makeHub({ getSnapshot: async () => null }), msg: activation() },
    { reason: 'snapshot_error', hub: () => makeHub({ getSnapshot: async () => { throw new Error('indexer down'); } }),
      msg: activation() },
];

describe('capability activation: unverified acceptance is surfaced', function () {
    let warns;
    beforeEach(function () {
        warns = [];
        sinon.stub(getLogger(), 'warn').callsFake(m => warns.push(String(m)));
    });
    afterEach(function () { sinon.restore(); });

    for (const u of UNVERIFIED) {
        it('accepts, counts and warns once for ' + u.reason, async function () {
            let hub = u.hub();
            let before = counterValue(CAP, u.reason);
            await hub.handleCapabilityMessage(u.msg);
            expect(hub.calls.qualification).to.deep.equal([true]);
            expect(hub.calls.enabled).to.deep.equal([true]);
            expect(counterValue(CAP, u.reason) - before).to.equal(1);
            expect(warns.filter(w => w.includes('WITHOUT a stake check (' + u.reason))).to.have.length(1);
        });
    }

    it('counts nothing for a claim the snapshot confirms', async function () {
        let hub = makeHub({ getSnapshot: async () => ({ validators: [] }), isInSnapshot: () => true });
        let before = counterValue(CAP, 'snapshot_unavailable');
        await hub.handleCapabilityMessage(activation());
        expect(hub.calls.qualification).to.deep.equal([true]);
        expect(counterValue(CAP, 'snapshot_unavailable')).to.equal(before);
        expect(warns.filter(w => w.includes('WITHOUT a stake check'))).to.have.length(0);
    });

    it('still rejects, uncounted, a claim the snapshot does not contain', async function () {
        let hub = makeHub({ getSnapshot: async () => ({ validators: [] }), isInSnapshot: () => false });
        await hub.handleCapabilityMessage(activation());
        expect(hub.calls.qualification).to.deep.equal([false]);
        expect(warns.filter(w => w.includes('WITHOUT a stake check'))).to.have.length(0);
    });

    it('counts every repeat but warns once per window', async function () {
        let hub = makeHub({ getSnapshot: async () => null });
        let before = counterValue(CAP, 'snapshot_unavailable');
        await hub.handleCapabilityMessage(activation());
        await hub.handleCapabilityMessage(activation());
        expect(counterValue(CAP, 'snapshot_unavailable') - before).to.equal(2);
        expect(warns.filter(w => w.includes('WITHOUT a stake check'))).to.have.length(1);
    });

    it('labels a capability outside the known set as other', async function () {
        let hub = makeHub({ getSnapshot: async () => null });
        let before = counterValue('other', 'snapshot_unavailable');
        await hub.handleCapabilityMessage(activation({ capability: 'made_up' })).catch(() => {});
        expect(counterValue('other', 'snapshot_unavailable') - before).to.equal(1);
        expect(counterValue('made_up', 'snapshot_unavailable')).to.equal(0);
    });
});
