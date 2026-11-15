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

const sinon      = require('sinon');
const { expect } = require('chai');
const Lifecycle  = require('../../../../src/hub/lifecycle.js');

// The oracle publisher's timers end in a signing round, a spend and a DB write, so
// close() has to stop it before the signer, the consensus and the pool it drives.

describe('hub close() and the oracle publisher', function () {
  it('stops the publisher before the batch signer, the consensus and the pool', async function () {
    let calls = [];
    let hub = Object.create(Lifecycle.prototype);
    hub.oraclePublisher   = { stop: () => calls.push('publisher') };
    hub.oracleBatchSigner = { stop: async () => calls.push('signer') };
    hub.oracleConsensus   = { stop: async () => calls.push('consensus') };
    hub.db                = { close: async () => calls.push('db') };

    await hub.close();

    expect(calls).to.deep.equal(['publisher', 'signer', 'consensus', 'db']);
  });

  it('closes a hub that never built a publisher', async function () {
    let hub = Object.create(Lifecycle.prototype);
    hub.db = { close: sinon.stub().resolves() };

    await hub.close();

    expect(hub.db.close.calledOnce).to.equal(true);
  });
});
