/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Pins the archive election-set and signing-capability seams.
 *
 ********************************************************************/

'use strict';

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../../../../../src/anchor/publisher');
const ValidatorIdentity    = require('../../../../../../src/validators/identity');
const { DB_METHODS }        = require('../../../../../helpers/mockHub.js');

const BLOCK = 100;
const CP_ROW = {
    id: 1, chain: 'BTC', network: 'regtest', block_index: 500, block_hash: 'c0'.repeat(32),
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    checkpoint_seq: BLOCK, snapshot_block: BLOCK, state_root: null, block_merkle_root: null
};
const MATCH_ROW = {
    id: 1, match_id: 'm'.repeat(64), snapshot_block: BLOCK, network: 'regtest',
    a_chain: 'BTC', a_action_index: 1, a_kind: 'swap', a_tick: 'AAA', a_amount: '1',
    a_filled_before: '0', a_ownership: 0, a_payout_addr: 'addrA',
    b_chain: 'DOGE', b_action_index: 2, b_kind: 'swap', b_tick: 'BBB', b_amount: '2',
    b_filled_before: '0', b_ownership: 0, b_payout_addr: 'addrB',
    effective_time: 10, finalizing_view: 0, validator_signatures: '[]', status: 'settled'
};

function buildPub(rows, network){
    rows = rows || {};
    const identity = new ValidatorIdentity('11'.repeat(32));
    const hub = {
        db: { ...DB_METHODS,
            async doQuery(sql){
                for(const frag of Object.keys(rows))
                    if(sql.indexOf(frag) !== -1) return rows[frag];
                return [];
            }
        },
        network: network || 'regtest',
        capabilitySnapshot: null,
        capabilityRegistry: null,
        getIdentity: () => identity,
        getPeerManager: () => ({ broadcast() {} }),
        p2pConfig: {},
        rewardTracker: null,
        resolveBtcLatestBlock: async () => BLOCK
    };
    return { pub: new StateAnchorPublisher(hub), identity };
}

function singleMemberRound(cpRow){
    const { pub, identity } = buildPub({
        'FROM cross_chain_matches WHERE batch_seq IS NULL': [MATCH_ROW],
        'FROM state_checkpoints':                           [cpRow]
    });
    const me = identity.getPubkeyHex().toLowerCase();
    const published = [];
    pub.getActiveOraclePublishPubkeys = async () => [me];
    pub.resolveCapabilitySet = async () => [{ pubkey: me, amount: '1', source: '' }];
    pub.getNextBatchSeq = async () => 7;
    pub.publishArchive = async round => { published.push(round); };
    return { pub, me, published };
}

describe('archive round set seams', function(){

    it('defaults to the active oracle_publish set and capability on every network', async function(){
        const { pub } = buildPub();
        const expected = ['aa', 'bb'];
        const blocks = [];
        pub.getActiveOraclePublishPubkeys = async block => {
            blocks.push(block);
            return expected;
        };

        expect(await pub.archiveElectionPubkeys(77, 'testnet')).to.equal(expected);
        expect(blocks).to.deep.equal([77]);
        for(const network of ['regtest', 'testnet', 'mainnet']){
            expect(pub.archiveSigningCapability({ network, snapshot_block: BLOCK }))
                .to.equal('oracle_publish');
        }
    });

    it('asks the election seam for the election block and hub network', async function(){
        const { pub, identity } = buildPub();
        const seen = [];
        const published = [];
        pub.archiveElectionPubkeys = async (block, network) => {
            seen.push([block, network]);
            return ['ff'.repeat(32)];
        };
        pub.getActiveOraclePublishPubkeys = async () => { throw new Error('inline election read'); };
        pub.publishArchive = async round => { published.push(round); };

        expect(identity.getPubkeyHex().toLowerCase()).not.to.equal('ff'.repeat(32));
        expect(await pub.startArchiveRound(null, BLOCK)).to.equal('none');
        expect(seen).to.deep.equal([[BLOCK, 'regtest']]);
        expect(published).to.deep.equal([]);
    });

    it('resolves a replacement signing capability on the checkpoint network', async function(){
        const checkpoint = { ...CP_ROW, network: 'testnet' };
        const { pub, me, published } = singleMemberRound(checkpoint);
        const seen = [];
        pub.archiveSigningCapability = () => 'sentinel_capability';
        pub.resolveCapabilitySet = async (capability, block, network) => {
            seen.push([capability, block, network]);
            return [{ pubkey: me, amount: '1', source: '' }];
        };

        expect(await pub.startArchiveRound(null, BLOCK)).to.equal('published');
        expect(seen.filter(args => args[0] === 'sentinel_capability'))
            .to.deep.equal([['sentinel_capability', BLOCK, 'testnet']]);
        expect(published).to.have.length(1);
    });

    it('keeps the genuine single-member publish path with the default seams', async function(){
        const { pub, me, published } = singleMemberRound(CP_ROW);

        expect(await pub.startArchiveRound(null, BLOCK)).to.equal('published');
        expect(published).to.have.length(1);
        expect(published[0].signatures.get(me)).to.be.a('string');
    });
});
