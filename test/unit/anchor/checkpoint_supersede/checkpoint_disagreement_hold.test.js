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
 **********************************************************************/

'use strict';

const { expect } = require('chai');
const StateCheckpointEngine = require('../../../../src/anchor/checkpoint_engine.js');
const canonicalForms = require('../../../../src/anchor/checkpoint_engine/canonical_forms.js');
const ValidatorIdentity = require('../../../../src/validators/identity.js');

const SNAP = 500;
const DIGEST = 'ef'.repeat(32);
const leader = new ValidatorIdentity('10'.repeat(32));
const follower = new ValidatorIdentity('11'.repeat(32));
const pubkey = (identity) => identity.getPubkeyHex().toLowerCase();

function block(overrides){
    return Object.assign({
        chain: 'BTC',
        network: 'regtest',
        block_index: 100,
        block_hash: 'aa'.repeat(32),
        ledger_hash: '11'.repeat(32),
        actions_hash: '22'.repeat(32),
        contract_hash: '33'.repeat(32),
        state_root: '44'.repeat(32),
        state_root_version: 1,
        block_merkle_root: '55'.repeat(32),
        block_merkle_version: 1,
    }, overrides);
}

function replay(overrides){
    return {
        digest: DIGEST,
        replay: Object.assign({
            state: 'replayed',
            target: 90,
            replay_to: 110,
            witness: 'passed',
            changed: true,
        }, overrides),
    };
}

function checkpoint(overrides){
    return Object.assign(block(), {
        checkpoint_seq: canonicalForms.deriveCheckpointSeq(SNAP),
        snapshot_block: SNAP,
        supersedes_from: null,
        rules_digest: null,
    }, overrides);
}

function buildEngine(cp, own, expectedSupersede){
    const broadcasts = [];
    const hub = {
        db: {},
        network: 'regtest',
        p2pConfig: {
            CHECKPOINT_CHAINS: 'BTC',
            CHECKPOINT_CONFIRMATIONS: '0',
            BTC_INDEXER_URL: 'http://stub',
        },
        getPeerManager: () => ({
            on() {},
            removeListener() {},
            broadcast(type, data) { broadcasts.push({ type, data }); },
        }),
        getIdentity: () => follower,
    };
    const engine = new StateCheckpointEngine(hub);
    engine.resolveSnapshotBlock = async () => SNAP;
    engine.resolveCapabilityValidators = async () => [leader, follower]
        .map((identity) => ({ pubkey: pubkey(identity), amount: '1' }));
    engine.followsCadenceLeader = () => true;
    engine.getMaxCheckpointSeq = async () => null;
    engine.indexerCall = async () => own;
    engine.supersedeFieldsForRound = async () => expectedSupersede;
    engine.roundTargetBlock = async () => own;
    engine.checkpointForRound = async () => cp;
    return { engine, broadcasts };
}

function signRequest(cp){
    const canonical = StateCheckpointEngine.canonicalCheckpoint(cp);
    return { data: {
        checkpoint: cp,
        sig_pubkey: pubkey(leader),
        sig: leader.sign(canonical),
    } };
}

async function captureWarnings(fn){
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try { await fn(); }
    finally { console.warn = originalWarn; }
    return warnings;
}

const CASES = [
    {
        reason: 'supersede_unwitnessed',
        cp: checkpoint({ supersedes_from: 90, rules_digest: DIGEST }),
        own: block({ rules: replay({ witness: 'running' }) }),
        expected: null,
    },
    {
        reason: 'supersede_no_disagreement',
        cp: checkpoint({ supersedes_from: 90, rules_digest: DIGEST }),
        own: block({ rules: replay() }),
        expected: null,
    },
    {
        reason: 'checkpoint_disagreement',
        cp: checkpoint(),
        own: block({ ledger_hash: '99'.repeat(32) }),
    },
    {
        reason: 'checkpoint_reorged',
        cp: checkpoint(),
        own: block({ block_hash: '99'.repeat(32) }),
    },
];

describe('checkpoint disagreement holds @regression', function () {
    for(const testCase of CASES){
        it('followers decline ' + testCase.reason + ' and log it once per seq', async function () {
            const { engine, broadcasts } = buildEngine(
                testCase.cp, testCase.own, testCase.expected);
            const request = signRequest(testCase.cp);
            const warnings = await captureWarnings(async () => {
                await engine.handleSignReq(request);
                await engine.handleSignReq(request);
            });

            expect(broadcasts).to.deep.equal([]);
            expect(engine._cosignDeclines[testCase.reason]).to.equal(2);
            expect(warnings.filter((line) => line.includes(testCase.reason)))
                .to.have.lengthOf(1);
        });

        it('leader rounds hold for ' + testCase.reason + ' and log it once per seq', async function () {
            const { engine, broadcasts } = buildEngine(
                testCase.cp, testCase.own, testCase.expected);
            const warnings = await captureWarnings(async () => {
                await engine.runRound('BTC', SNAP, []);
                await engine.runRound('BTC', SNAP, []);
            });

            expect(engine.pending.size).to.equal(0);
            expect(broadcasts).to.deep.equal([]);
            expect(warnings.filter((line) => line.includes(testCase.reason)))
                .to.have.lengthOf(1);
        });
    }

    it('co-signs a witnessed supersede that local finalized rows need', async function () {
        const cp = checkpoint({ supersedes_from: 90, rules_digest: DIGEST });
        const own = block({ rules: replay() });
        const expected = { supersedes_from: 90, rules_digest: DIGEST };
        const { engine, broadcasts } = buildEngine(cp, own, expected);

        await engine.handleSignReq(signRequest(cp));

        expect(broadcasts.map((entry) => entry.type)).to.deep.equal(['XCHK_SIGN']);
        expect(engine._lastCosignDeclineReason).to.equal(null);
    });
});
