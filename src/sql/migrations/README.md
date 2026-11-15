# Hub SQL migrations

Dated `.sql` files applied by the hub's migration runner (`src/db/schema/migration_runner.js`).
Every file name starts with `YYYY-MM-DD-` so lexical order is authorship order.

## Manual migrations

A file tagged `-- xchain:migration mode=manual` is never run by a boot. A boot records it as applied
when the live schema already holds its end state and otherwise logs it as pending. An operator applies
the pending files with `npm run migrate`, or one file with
`npm run migrate -- --file <name>`.

## Manual runbooks

A file tagged `-- xchain:runbook` is a one-off operator script (a data correction, or a change that
errors on a hub that already has it). A blanket run, boot or `npm run migrate`, lists it under
runbooks and does not examine or apply it. Run one by naming it:

    npm run migrate -- --file 2026-09-11-price-ingest-watermarks-network-column.sql

Read the file's header first; each runbook says what it changes and how to check the result.

- `2026-06-02-backfill-price-snapshot-reference-chain.sql`: restores `price_snapshots.reference_chain` from `source_chain`. Superseded by `2026-11-15-backfill-price-snapshot-reference-chain-guarded.sql`: this file also rewrites the rounds the hub finalized itself, so run the guarded file instead.
- `2026-11-15-backfill-price-snapshot-reference-chain-guarded.sql`: the same correction limited to rows that name a source action, with a check for hubs that already ran the earlier file.
- `2026-09-11-price-ingest-watermarks-network-column.sql`: re-keys `price_ingest_watermarks` by network.
- `2026-10-24-z-price-snapshots-archive-pending-index.sql`: superseded by `2026-11-14-price-snapshots-archive-pending-column.sql`, a manual migration a boot baselines or reports pending; no separate run is needed.
