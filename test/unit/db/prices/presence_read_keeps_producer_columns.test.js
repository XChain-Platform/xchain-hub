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

// The re-land and repair paths decide which pairs of a round this hub finalized itself
// from the presence read alone. A producer row projected down to the columns that read
// really selects must still be recognised, or the batch upsert rewrites its BTC anchor.

const { expect }             = require('chai');
const { isProducerRoundRow } = require('../../../../src/peers/hub_db/price_round_groups.js');
const { presenceColumns, projectRow } = require('../../../helpers/prices/presence_projection');

const producerRow = () => ({
    id: 7, round_number: 300, coin_pair: 'BTC/USD', price: '50000', status: 'finalized',
    reference_block: 799300, reference_chain: 'BTC', source_chain: 'DOGE', source_action_index: null,
    push_generation: 0, consensus_proof: '["sig-a","sig-b"]', block_timestamp: 1700000000, batch_block_time: 0
});

describe('price presence read projection', function () {
    it('keeps a self-finalized producer row recognisable after projection', async function () {
        const projected = projectRow(producerRow(), await presenceColumns());
        expect(isProducerRoundRow(projected)).to.equal(true);
        expect(projected.coin_pair).to.equal('BTC/USD');
    });

    it('selects an explicit column list rather than whole rows', async function () {
        const columns = await presenceColumns();
        expect(columns).to.include.members(['round_number', 'coin_pair', 'status', 'reference_chain',
            'source_chain', 'source_action_index', 'push_generation', 'consensus_proof']);
        expect(columns).not.to.include('*');
    });

    it('projects away a column the read does not select', async function () {
        const projected = projectRow(producerRow(), await presenceColumns());
        expect(projected).not.to.have.property('price');
        expect(projected).not.to.have.property('reference_block');
    });
});
