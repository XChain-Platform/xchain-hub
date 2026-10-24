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

const { expect }           = require('chai');
const sinon                = require('sinon');
const StateAnchorPublisher = require('../../../../../../src/anchor/publisher');
const { DB_METHODS }        = require('../../../../../helpers/mockHub.js');

const KEY_A = 'aa'.repeat(33);
const KEY_B = 'bb'.repeat(33);
const BLOCK = 100;

function publisher(options){
    options = options || {};
    const queries = [];
    const hub = {
        db: { ...DB_METHODS, async doQuery(sql, params){
            queries.push(params);
            return options.rows || [];
        } },
        network: options.network || 'regtest',
        capabilitySnapshot: options.capabilitySnapshot || null,
        capabilityRegistry: null,
        getIdentity: () => options.identity || null,
        getPeerManager: () => ({ broadcast() {} }),
        p2pConfig: {},
        resolveBtcLatestBlock: async () => BLOCK
    };
    return { pub: new StateAnchorPublisher(hub), queries };
}

describe('archive_publish archive election', function () {
    afterEach(function () { sinon.restore(); });

    it('drops an absent oracle publisher above the gate and preserves the oracle set below it', async function () {
        const calls = [];
        const snapshot = {
            async getWeightSnapshot(capability){
                calls.push(capability);
                return { validators: capability === 'archive_publish'
                    ? [{ pubkey: KEY_A, source: 'source-a', weight: '1' }]
                    : [{ pubkey: KEY_A, source: 'source-a', weight: '1' },
                       { pubkey: KEY_B, source: 'source-b', weight: '1' }] };
            },
            async getSnapshot(capability){
                calls.push(capability);
                return { validators: [{ pubkey: KEY_A }, { pubkey: KEY_B }] };
            }
        };
        const { pub } = publisher({ capabilitySnapshot: snapshot });

        expect(await pub.getActiveOraclePublishPubkeys(BLOCK)).to.deep.equal([KEY_A, KEY_B]);
        expect(await pub.getArchivePublishPubkeys(BLOCK, 'regtest')).to.deep.equal([KEY_A]);
        expect(await pub.getArchivePublishPubkeys(BLOCK, 'mainnet')).to.deep.equal([KEY_A, KEY_B]);
        expect(calls).to.deep.equal(['oracle_publish', 'archive_publish', 'oracle_publish']);
        expect(pub.archiveSigningCapability({ network: 'regtest', snapshot_block: BLOCK }))
            .to.equal('archive_publish');
        expect(pub.archiveSigningCapability({ network: 'mainnet', snapshot_block: BLOCK }))
            .to.equal('oracle_publish');

        sinon.stub(pub, 'resolveCapabilitySet').resolves([]);
        await pub.archiveSigningSet({ network: 'regtest', snapshot_block: BLOCK });
        expect(pub.resolveCapabilitySet.calledOnceWithExactly('archive_publish', BLOCK, 'regtest'))
            .to.equal(true);
    });

    it('uses the passed archive capability key for the regtest local-table fallback', async function () {
        const { pub, queries } = publisher({
            rows: [{ signing_pubkey: KEY_B.toUpperCase() }, { signing_pubkey: KEY_A }]
        });

        expect(await pub.getArchivePublishPubkeys(BLOCK, 'regtest')).to.deep.equal([KEY_A, KEY_B]);
        expect(queries).to.deep.equal([[BLOCK, 'archive_publish']]);
    });

    it('defers the round when the archive_publish election set cannot be resolved', async function () {
        const { pub } = publisher();
        sinon.stub(pub, 'getArchivePublishPubkeys').resolves([]);
        const gather = sinon.stub(pub, 'gatherUnpublishedArchiveRows').throws(new Error('must not gather'));

        expect(await pub.startArchiveRound(null, BLOCK)).to.equal('none');
        expect(pub.getArchivePublishPubkeys.calledOnceWithExactly(BLOCK, 'regtest')).to.equal(true);
        expect(gather.called).to.equal(false);
    });
});
