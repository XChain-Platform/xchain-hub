/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const anchor = require('../../../../../src/attestation/batch_publisher/anchor.js');

function publisher(freshTip, observedTip){
    let calls = [];
    let p = Object.assign({}, anchor, {
        network: 'regtest',
        hub: {
            resolveFreshPushedBtcTip: async (network) => {
                calls.push(network);
                return freshTip;
            },
            getAttestationRound: () => ({ getObservedBtcTip: () => observedTip })
        },
        hubDb: () => ({
            getChainTip: async () => { throw new Error('resolveAnchor read the database directly'); }
        })
    });
    return { p, calls };
}

describe('AttestationBatchPublisher fresh pushed tip anchor', function () {
    it('takes the pushed tip only through the hub freshness resolver', async function () {
        let h = publisher({ blockHeight: 550, blockTime: 2 }, { blockHeight: 600 });

        expect(await h.p.resolveAnchor()).to.equal(550);
        expect(h.calls).to.deep.equal(['regtest']);
        expect(h.p._anchorSource).to.equal('pushed');
    });

    it('falls back to the observed tip when no fresh pushed tip resolves', async function () {
        let h = publisher(null, { blockHeight: 600 });

        expect(await h.p.resolveAnchor()).to.equal(600);
        expect(h.calls).to.deep.equal(['regtest']);
        expect(h.p._anchorSource).to.equal('observed');
    });
});
