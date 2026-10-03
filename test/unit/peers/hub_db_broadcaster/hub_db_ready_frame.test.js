'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const sinon = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { DB_METHODS } = require('../../../helpers/mockHub');

const INSTANCE_ONE = 'de305d54-75b4-431b-adb2-eb6b9e546014';
const INSTANCE_TWO = '123e4567-e89b-42d3-a456-426614174000';

function makeWs() {
    return {
        readyState: 1,
        bufferedAmount: 0,
        send: sinon.stub(),
        close: sinon.stub(),
        on: sinon.stub()
    };
}

describe('hub DB ready frame identity and ceilings', function () {
    let HubDbBroadcaster;

    beforeEach(function () {
        HubDbBroadcaster = proxyquire('../../../../src/peers/hub_db_broadcaster', {
            ws: { OPEN: 1 }
        });
    });

    afterEach(function () {
        sinon.restore();
    });

    it('advertises all mirrored-table ceilings with snapshot-equivalent filters', async function () {
        const queries = [];
        const db = {
            ...DB_METHODS,
            doQuery: sinon.stub().callsFake(async sql => {
                queries.push(String(sql));
                if(String(sql).includes('SELECT value FROM consensus_state'))
                    return [{ value: INSTANCE_ONE }];
                return [{ max_id: 29 }];
            })
        };
        const broadcaster = new HubDbBroadcaster({}, db);
        const ws = makeWs();

        await broadcaster.addSubscriber(ws);
        const ready = JSON.parse(ws.send.firstCall.args[0]);

        expect(ready.hub_instance_id).to.equal(INSTANCE_ONE);
        expect(ready.max_ids).to.deep.equal({
            price_snapshots: 29,
            oracle_prices: 29,
            cross_chain_matches: 29,
            capability_snapshots: 29,
            state_checkpoints: 29,
            anchor_reward_attestations: 29,
            cross_chain_calls: 29,
            bridge_transfers: 29,
            policy_snapshots: 29,
            list_snapshots: 29,
            attestation_responses: 29
        });
        const bridgeMax = queries.find(sql => sql.includes('MAX(id)') && sql.includes('FROM bridge_transfers'));
        const policyMax = queries.find(sql => sql.includes('MAX(id)') && sql.includes('FROM policy_snapshots'));
        const listMax = queries.find(sql => sql.includes('MAX(id)') && sql.includes('FROM list_snapshots'));
        expect(bridgeMax).to.include("status <> 'retracted'");
        expect(policyMax).not.to.include('status');
        expect(listMax).not.to.include('status');
        broadcaster.stop();
    });

    it('keeps the identity for one database and creates a new one after rebuild', async function () {
        let stored = null;
        let created = 0;
        const db = {
            ...DB_METHODS,
            doQuery: sinon.stub().callsFake(async sql => {
                const statement = String(sql);
                if(statement.includes('SELECT value FROM consensus_state'))
                    return stored ? [{ value: stored }] : [];
                if(statement.includes('INSERT IGNORE INTO consensus_state')) {
                    if(!stored) stored = created++ === 0 ? INSTANCE_ONE : INSTANCE_TWO;
                    return { affectedRows: 1 };
                }
                throw new Error('Unexpected SQL: ' + statement);
            })
        };

        expect(await db.getHubInstanceId()).to.equal(INSTANCE_ONE);
        expect(await db.getHubInstanceId()).to.equal(INSTANCE_ONE);
        stored = null;
        expect(await db.getHubInstanceId()).to.equal(INSTANCE_TWO);

        const inserts = db.doQuery.getCalls().filter(call =>
            String(call.args[0]).includes('INSERT IGNORE INTO consensus_state'));
        expect(inserts).to.have.length(2);
        expect(inserts[0].args[0]).to.include('UUID()');
    });
});
