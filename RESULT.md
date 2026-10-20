# Lane report: cx-xc-5703

## Work
- Checked out base commit 2a57ebf (matches the fetched base ref) and created cloud/run-e04585a8b2a3 from it.
- Merged develop (f858709) as "sync trunk". Two conflicts, both resolved keeping both sides:
  - src/db/index.js: Database.io now carries sqlDir, migrationsDir (this row's runner) and migrationFiles (develop's sql_migration_files helpers).
  - test/unit/db/schema/sql_migration_files.test.js: develop's helper tests kept under that name; this row's migrations-directory tests moved to test/unit/db/schema/sql_migration_dir_files.test.js.
- The merge commit necessarily carries develop's own changes to paths outside Surfaces; that is develop content, not edits made by this lane.
- The four retired JS files (migrations.js, columns.js, keys.js, datetime_columns.js) are absent after the merge; src/sql/migrations holds the 8 dated .sql files.

## Files touched by this lane
src/db/index.js, test/unit/db/schema/sql_migration_files.test.js, test/unit/db/schema/sql_migration_dir_files.test.js (plus the merge of develop).

## Tests
- `npx mocha 'test/unit/db/**/*.test.js'`: 363 passing, 0 failing.
- Full `npm test` (after npm ci): 8907 passing, 151 pending, 26 failing. Verify did NOT fully pass.
  - 5 failures in test/unit/attestation/response_mirror/attestation_response_mirror_charset.test.js: it calls the retired db.migrateColumnCharset and stubs the retired migrate* helpers. It is outside Surfaces and develop did not change it, so it needs updating to the dated-.sql runner (the equivalent migration is 2026-10-19-enum-charset-and-voting-window-widens.sql). Needs an orchestrator decision or a row that covers that path.
  - 21 failures are environmental: unwritable-path tests (AttestationPublisher queue I/O, SpendGuard) fail because the sandbox runs as root; xchain-documentation and indexer sibling checkouts are absent (FULLNODE comment, PRICE v0 canonical admission).
- The structural half of Verify (dir, 20*.sql glob, four files absent) holds.

RUN-COMPLETE 225a772d8d1e2fd7b13b72ad5579b730
