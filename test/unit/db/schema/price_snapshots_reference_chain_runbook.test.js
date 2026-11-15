'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

// A hub-finalized price round is stored with the column default for source_chain, a NULL source action
// and reference_chain BTC, and that shape is how catch-up tells a producer round from a pushed one. The
// reference_chain backfill runbooks must therefore never rewrite such a row.

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { isRunbook, migrationMode, splitMigrationStatements } =
    require('../../../../src/db/schema/sql_migration_files.js');
const { isProducerRoundRow } = require('../../../../src/peers/hub_db/price_round_groups.js');
const pricesDb = require('../../../../src/db/prices/index.js');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const MIGRATIONS = path.join(ROOT, 'src', 'sql', 'migrations');
const GUARDED = '2026-11-15-backfill-price-snapshot-reference-chain-guarded.sql';
const SUPERSEDED = '2026-06-02-backfill-price-snapshot-reference-chain.sql';

function read(...parts) { return fs.readFileSync(path.join(...parts), 'utf8'); }

function producerRow() {
    return { status: 'finalized', reference_chain: 'BTC', source_chain: 'DOGE', source_action_index: null,
        push_generation: 0, consensus_proof: '[{"pubkey":"aa","sig":"bb"}]' };
}

describe('price_snapshots reference_chain backfill runbooks', function () {
    it('keeps the column shape that identifies a hub-finalized round', function () {
        const table = read(ROOT, 'src', 'sql', 'price_snapshots.sql');
        expect(table).to.match(/source_chain\s+VARCHAR\(10\) NOT NULL DEFAULT 'DOGE'/);
        expect(table).to.match(/source_action_index BIGINT,/);
        const writer = String(pricesDb.setFinalizedPriceSnapshotRound);
        expect(writer).to.not.contain('source_chain');
        expect(writer).to.not.contain('source_action_index');
        expect(isProducerRoundRow(producerRow())).to.equal(true);
    });

    it('shows the unguarded runbook turning a producer round into a row catch-up cannot mirror', function () {
        const unguarded = read(MIGRATIONS, SUPERSEDED);
        expect(unguarded).to.contain("source_chain IN ('LTC', 'DOGE')");
        expect(unguarded).to.not.contain('source_action_index');
        const rewritten = Object.assign(producerRow(), { reference_chain: producerRow().source_chain });
        expect(isProducerRoundRow(rewritten)).to.equal(false);
    });

    it('ships a guarded runbook that only rewrites rows naming a source action', function () {
        const raw = read(MIGRATIONS, GUARDED);
        expect(isRunbook(raw)).to.equal(true);
        expect(migrationMode(raw)).to.equal('manual');
        const writes = splitMigrationStatements(raw).filter(statement => /^\s*UPDATE\b/i.test(statement));
        expect(writes).to.have.lengthOf(1);
        expect(writes[0]).to.match(/source_action_index IS NOT NULL/);
        expect(writes[0]).to.match(/reference_chain = 'BTC'/);
        for (const statement of splitMigrationStatements(raw)) {
            if (/^\s*SELECT\b/i.test(statement)) expect(statement).to.not.match(/\b(UPDATE|DELETE|INSERT)\b/i);
        }
    });

    it('marks the unguarded runbook as superseded in the migrations readme', function () {
        const readme = read(MIGRATIONS, 'README.md');
        const line = readme.split('\n').find(text => text.includes(SUPERSEDED));
        expect(line).to.contain(GUARDED);
        expect(readme).to.contain('`' + GUARDED + '`');
    });
});
