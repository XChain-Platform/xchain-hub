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

// Pins the archive selector's chain-derived filter and the round's verdict when nothing
// else is pending. Without the filter each archive publish recorded an anchor_archive
// reward that the next flush archived alone: one reward-only ANCHOR per hub restart.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../src/StateAnchorPublisher');
const ValidatorIdentity    = require('../../src/ValidatorIdentity');
const ar                   = require('../../src/anchor_reward_activation');

const BLOCK = 100;

function mkPub(network, rewardRows, hits){
    const identity = new ValidatorIdentity('11'.repeat(32));
    const pub = new StateAnchorPublisher({
        db: {
            async doQuery(sql, params){
                hits.push(sql);
                if(sql.indexOf('FROM validator_rewards WHERE reward_type LIKE') !== -1) return rewardRows;
                return [];
            }
        },
        network, p2pConfig: {},
        getIdentity: () => identity,
        getPeerManager: () => ({ on(){}, removeListener(){}, broadcast(){} }),
        _resolveBtcLatestBlock: async () => BLOCK
    });
    const me = identity.getPubkeyHex().toLowerCase();
    pub._getActiveOraclePublishPubkeys = async () => [me];
    return pub;
}

function row(type, block){
    return { validator_pubkey: 'aa'.repeat(32), reward_type: type, round_number: 1,
             amount: '10.00000000', block_index: block, batch_seq: null };
}

describe('StateAnchorPublisher: chain-derived rewards are not archive cargo', () => {

    describe('_isChainDerivedReward', () => {
        it('marks every anchor reward type derived at/above its flag-day (regtest activates at 0)', () => {
            const pub = mkPub('regtest', [], []);
            for(const t of ['anchor_BTC', 'anchor_LTC', 'anchor_DOGE', 'anchor_bundle', 'anchor_archive'])
                expect(pub._isChainDerivedReward(row(t, 5)), t).to.equal(true);
        });

        it('keeps a row below its flag-day as hub-pushed cargo', () => {
            const pub = mkPub('mainnet', [], []);
            const belowChain   = ar.ANCHOR_REWARD_ACTIVATION.mainnet - 1;
            const belowArchive = ar.ARCHIVE_REWARD_ACTIVATION.mainnet - 1;
            expect(pub._isChainDerivedReward(row('anchor_BTC', belowChain))).to.equal(false);
            expect(pub._isChainDerivedReward(row('anchor_bundle', belowChain))).to.equal(false);
            expect(pub._isChainDerivedReward(row('anchor_archive', belowArchive))).to.equal(false);
            expect(pub._isChainDerivedReward(row('anchor_BTC', ar.ANCHOR_REWARD_ACTIVATION.mainnet))).to.equal(true);
            expect(pub._isChainDerivedReward(row('anchor_archive', ar.ARCHIVE_REWARD_ACTIVATION.mainnet))).to.equal(true);
        });

        it('never marks a non-anchor type, a row without a block, or an unscoped hub', () => {
            const pub = mkPub('regtest', [], []);
            expect(pub._isChainDerivedReward(row('oracle_round', 5))).to.equal(false);
            expect(pub._isChainDerivedReward(row('anchor_archive', null))).to.equal(false);
            const unscoped = mkPub('', [], []);
            expect(unscoped._isChainDerivedReward(row('anchor_archive', 5))).to.equal(false);
        });
    });

    describe('_startArchiveRound', () => {
        it('answers none, and never reaches the checkpoint wrapper, when only derived rows are pending', async () => {
            const hits = [];
            const pub = mkPub('regtest', [row('anchor_archive', 5), row('anchor_bundle', 6)], hits);
            const verdict = await pub._startArchiveRound({ broadcastFn: () => {} }, BLOCK, false);
            expect(verdict).to.equal('none');
            expect(hits.some(s => s.indexOf('FROM validator_rewards WHERE reward_type LIKE') !== -1),
                'the pending-reward query ran').to.equal(true);
            expect(hits.some(s => s.indexOf('FROM state_checkpoints') !== -1),
                'the round went on to select a checkpoint wrapper for cargo that is not cargo').to.equal(false);
            expect(pub._pendingMatches).to.equal(0);
        });

        it('still carries a hub-pushed row below the flag-day into the round', async () => {
            const hits = [];
            const below = ar.ARCHIVE_REWARD_ACTIVATION.mainnet - 1;
            const pub = mkPub('mainnet', [row('anchor_archive', below)], hits);
            await pub._startArchiveRound({ broadcastFn: () => {} }, BLOCK, false);
            expect(hits.some(s => s.indexOf('FROM state_checkpoints') !== -1),
                'a below-flag-day row must reach the checkpoint wrapper selection').to.equal(true);
        });
    });

    // Derived rows are NEVER stamped with a batch_seq, so they stay eligible for the
    // pending-reward SELECT forever and their number grows by one on every archive
    // publish. With the LIMIT applied before the JS filter, a maxBatch-sized block of
    // them owned the page permanently and the below-flag-day rows sorted behind them
    // stopped being reachable at all, losing their only recovery transport.
    describe('the pending-reward page is narrowed before its LIMIT', () => {

        // A fake that actually executes the statement: it honours the bound thresholds,
        // the ORDER BY and the LIMIT. A fake that ignored them could not go red here.
        function mkSelector(network, rows, maxBatch, hits){
            const identity = new ValidatorIdentity('11'.repeat(32));
            const pub = new StateAnchorPublisher({
                db: {
                    async doQuery(sql, params){
                        hits.push({ sql, params });
                        if(sql.indexOf('FROM validator_rewards WHERE reward_type LIKE') === -1) return [];
                        let p = (params || []).slice();
                        let limit = p.pop();
                        let out = rows.slice();
                        while(p.length){
                            // Each NOT clause is (types..., threshold); the archive clause
                            // carries exactly one type.
                            let threshold = null, types = [];
                            while(p.length && typeof p[0] === 'string') types.push(p.shift());
                            threshold = p.shift();
                            out = out.filter(r => !(types.indexOf(r.reward_type) !== -1 &&
                                                    Number(r.block_index) >= Number(threshold)));
                        }
                        // CASE-INSENSITIVE, because the column's collation is: under
                        // MariaDB's default 'anchor_archive' sorts BEFORE 'anchor_LTC',
                        // and a case-sensitive JS compare puts them the other way round,
                        // which would make the starvation case below unable to go red.
                        out.sort((a, b) => {
                            let x = String(a.reward_type).toLowerCase();
                            let y = String(b.reward_type).toLowerCase();
                            return x < y ? -1 : x > y ? 1 : a.round_number - b.round_number;
                        });
                        return out.slice(0, limit);
                    }
                },
                network, p2pConfig: {},
                getIdentity: () => identity,
                getPeerManager: () => ({ on(){}, removeListener(){}, broadcast(){} }),
                _resolveBtcLatestBlock: async () => BLOCK
            });
            pub.maxBatch = maxBatch;
            const me = identity.getPubkeyHex().toLowerCase();
            pub._getActiveOraclePublishPubkeys = async () => [me];
            return pub;
        }

        it('reaches a legacy reward sitting behind a full page of never-archivable rows', async () => {
            const hits = [];
            const aboveArchive = ar.ARCHIVE_REWARD_ACTIVATION.mainnet + 1;
            const belowAnchor  = ar.ANCHOR_REWARD_ACTIVATION.mainnet - 1;
            // 'anchor_LTC' sorts AFTER 'anchor_archive' under this ORDER BY, which is why
            // two derived rows and a maxBatch of 2 starved it before the narrowing.
            const rows = [row('anchor_archive', aboveArchive), row('anchor_archive', aboveArchive + 1),
                          row('anchor_LTC', belowAnchor)];
            rows[1].round_number = 2;
            const pub = mkSelector('mainnet', rows, 2, hits);

            await pub._startArchiveRound({ broadcastFn: () => {} }, BLOCK, false);

            expect(hits.some(h => h.sql.indexOf('FROM state_checkpoints') !== -1),
                'the starved legacy reward must reach the checkpoint wrapper selection').to.equal(true);
        });

        it('binds this hub\'s own two flag-days, and keeps the unnarrowed form off-network', async () => {
            let hits = [];
            let pub = mkSelector('mainnet', [], 5, hits);
            await pub._startArchiveRound({ broadcastFn: () => {} }, BLOCK, false);
            let q = hits.find(h => h.sql.indexOf('FROM validator_rewards WHERE reward_type LIKE') !== -1);
            expect(q.sql).to.contain('AND NOT (reward_type IN (?, ?, ?, ?) AND block_index >= ?)');
            expect(q.sql).to.contain('AND NOT (reward_type = ? AND block_index >= ?)');
            expect(q.params).to.deep.equal(['anchor_BTC', 'anchor_LTC', 'anchor_DOGE', 'anchor_bundle',
                                            ar.ANCHOR_REWARD_ACTIVATION.mainnet,
                                            'anchor_archive', ar.ARCHIVE_REWARD_ACTIVATION.mainnet, 5]);

            // An unscoped hub has no thresholds to bind, and _isChainDerivedReward answers
            // false for every row there, so the selector must stay exactly as it was.
            hits = [];
            pub = mkSelector('', [], 5, hits);
            await pub._startArchiveRound({ broadcastFn: () => {} }, BLOCK, false);
            q = hits.find(h => h.sql.indexOf('FROM validator_rewards WHERE reward_type LIKE') !== -1);
            expect(q.sql).to.not.contain('AND NOT (');
            expect(q.params).to.deep.equal([5]);
        });

        it('excludes every anchor row on regtest, where both flag-days sit at 0', async () => {
            // Intended, not a regression: it is exactly what the JS filter already
            // produced there, only now the LIMIT never sees those rows.
            const hits = [];
            const pub = mkSelector('regtest', [row('anchor_archive', 5), row('anchor_BTC', 5)], 5, hits);
            await pub._startArchiveRound({ broadcastFn: () => {} }, BLOCK, false);
            expect(hits.some(h => h.sql.indexOf('FROM state_checkpoints') !== -1),
                'nothing on regtest is archive cargo, so no wrapper is selected').to.equal(false);
        });
    });
});
