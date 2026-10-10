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

const sinon       = require('sinon');
const { expect }  = require('chai');
const mirrorKeys  = require('../../../../src/db/schema/mirror_keys.js');

const WIDE_KEYS = {
    capability_snapshots: ['snapshot_block', 'capability', 'signing_pubkey', 'source'],
    attestation_responses: ['network', 'request_id', 'effective_time']
};

function makeDb(overrides = {}){
    const connection = {
        query: sinon.stub().callsFake(async (sql, args) => {
            if(sql.includes('information_schema.tables')) return [{ present: 1 }];
            const columns = overrides[args[1]] || WIDE_KEYS[args[1]] || [];
            return columns.map(column => ({ col: column, non_unique: 0 }));
        }),
        release: sinon.stub().resolves()
    };
    const db = {
        dbName: 'hub_test',
        getConnection: sinon.stub().resolves(connection)
    };
    return { db, connection };
}

async function acceptsWideUniqueKeys() {
    const { db, connection } = makeDb();
    await mirrorKeys.assertMirrorKeysWide.call(db);

    expect(connection.query.callCount).to.equal(2);
    expect(connection.query.firstCall.args[0]).to.contain('non_unique');
    expect(connection.query.firstCall.args[1]).to.deep.equal(
        ['hub_test', 'capability_snapshots', 'uq_cap_snap']);
    expect(connection.query.secondCall.args[1]).to.deep.equal(
        ['hub_test', 'attestation_responses', 'uq_attest_response']);
    expect(connection.release.calledOnce).to.equal(true);
}

async function refusesNarrowCapabilitySnapshotKey() {
    const { db, connection } = makeDb({
        capability_snapshots: ['snapshot_block', 'capability', 'signing_pubkey']
    });

    let thrown = null;
    try {
        await mirrorKeys.assertMirrorKeysWide.call(db);
    } catch(error) { thrown = error; }

    expect(thrown).to.be.an('error');
    expect(thrown.message).to.match(/Refusing to start/);
    expect(thrown.message).to.match(/capability_snapshots/);
    expect(thrown.message).to.match(/source/);
    expect(connection.release.calledOnce).to.equal(true);
}

async function refusesAbsentAttestationResponseKey() {
    const { db, connection } = makeDb({ attestation_responses: [] });

    let thrown = null;
    try {
        await mirrorKeys.assertMirrorKeysWide.call(db);
    } catch(error) { thrown = error; }

    expect(thrown).to.be.an('error');
    expect(thrown.message).to.match(/attestation_responses/);
    expect(thrown.message).to.match(/no index/);
    expect(connection.release.calledOnce).to.equal(true);
}

async function refusesNonUniqueMirrorKey() {
    const { db, connection } = makeDb();
    connection.query.onSecondCall().resolves(
        WIDE_KEYS.attestation_responses.map(column => ({ col: column, non_unique: 1 })));

    let thrown = null;
    try {
        await mirrorKeys.assertMirrorKeysWide.call(db);
    } catch(error) { thrown = error; }

    expect(thrown).to.be.an('error');
    expect(thrown.message).to.match(/not unique/);
    expect(connection.release.calledOnce).to.equal(true);
}

async function acceptsMissingTablesBeforeBootstrap() {
    const { db, connection } = makeDb();
    connection.query.callsFake(async sql => {
        if(sql.includes('information_schema.tables')) return [];
        return [];
    });

    await mirrorKeys.assertMirrorKeysWide.call(db);

    expect(connection.query.callCount).to.equal(4);
    expect(connection.release.calledOnce).to.equal(true);
}

async function releasesConnectionAfterCatalogueFailure() {
    const { db, connection } = makeDb();
    connection.query.rejects(new Error('catalogue unavailable'));

    let thrown = null;
    try {
        await mirrorKeys.assertMirrorKeysWide.call(db);
    } catch(error) { thrown = error; }

    expect(thrown).to.be.an('error');
    expect(thrown.message).to.equal('catalogue unavailable');
    expect(connection.release.calledOnce).to.equal(true);
}

describe('assertMirrorKeysWide()', function () {
    it('accepts both unique mirror keys only when all widened columns are present in order', acceptsWideUniqueKeys);
    it('refuses startup when the capability snapshot key is still narrow', refusesNarrowCapabilitySnapshotKey);
    it('refuses startup when the attestation response key is absent', refusesAbsentAttestationResponseKey);
    it('refuses startup when a named mirror key is not unique', refusesNonUniqueMirrorKey);
    it('allows runMigrations before the mirror tables exist', acceptsMissingTablesBeforeBootstrap);
    it('releases the connection when the catalogue read fails', releasesConnectionAfterCatalogueFailure);
});
