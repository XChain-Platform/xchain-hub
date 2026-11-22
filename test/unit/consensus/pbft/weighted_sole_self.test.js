'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon');
const { expect } = require('chai');
const Consensus = require('../../../../src/consensus/pbft');
const federation = require('../../../../src/consensus/federation.js');
const { createMockHub } = require('../../../helpers/mockHub');

describe('weighted sole-self config rounds', function () {
    afterEach(function () { sinon.restore(); });

    it('recognizes only a non-empty snapshot containing this one key', function () {
        const self = 'aa'.repeat(32);
        expect(federation.isSoleSelfFederation([
            { pubkey: self, source: 'a' }, { pubkey: self.toUpperCase(), source: 'b' }
        ], self)).to.equal(true);
        expect(federation.isSoleSelfFederation([
            { pubkey: self }, { pubkey: 'bb'.repeat(32) }
        ], self)).to.equal(false);
        expect(federation.isSoleSelfFederation([], self)).to.equal(false);
        expect(federation.isSoleSelfFederation([{ pubkey: self }], null)).to.equal(false);
    });

    it('applies directly when one weighted signing key has several source rows', async function () {
        const hub = createMockHub();
        const consensus = new Consensus(hub);
        const self = consensus.selfPubkey();
        const snapshot = { blockIndex: 800000, count: 2, validators: [
            { pubkey: self.toUpperCase(), source: 'source-a', weight: '40' },
            { pubkey: self, source: 'source-b', weight: '60' }
        ] };
        sinon.stub(consensus, 'lockSnapshot').resolves({
            snapshot, weighted: true, requestedBlockIndex: 800000
        });
        hub.capabilitySnapshot = { getQuorum: sinon.stub().returns(2) };

        expect(await consensus.propose({ cfg: 2 })).to.equal(true);
        expect(hub.applyConfig.calledOnce).to.equal(true);
        expect(hub._peerManager.broadcast.called).to.equal(false);
    });
});
