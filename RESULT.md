# Lane report: cx-xc-5959

## Files touched
- src/anchor/publisher/archive/checkpoint_price/checkpoint_price_verify.js (comment only)

## Findings
The base already contains the fix for this row (commit b6222def, "Take a rolled-back PRICE batch landing's clock off self-finalized rows"): stampSelfFinalizedLandingSource and the reset helpers in src/db/prices/index.js, resetLandingStampedRows in retract.js, the landing source passed from batch_ingest.js, and the source_chain pass-through in price_round_groups.js. I reviewed the mirror upsert (a reset row with batch_block_time 0 does overwrite a later clock, and a re-landing then fills the 0) and the finalized_apply and verifyArchivedPriceGroup compares, and found no further code defect. The only stale item was a comment in checkpoint_price_verify.js saying a self-finalized row keeps an orphaned stamp; that is corrected.

## Not done (parked)
The acceptance test (stamp a self-finalized row from a landing, roll it back, re-land later, compare two hubs and run verifyArchivedPriceGroup) needs a new file under test/, which is outside Surfaces, so I did not write it. The orchestrator should assign it to a lane that may write test/unit/.

## Tests
npm ci --ignore-scripts, then mocha on price_aggregator_batch_landing_time.test.js, test/unit/anchor/publisher/archive/price/*.test.js and hub_db_broadcaster_chain_ingest.test.js: 48 passing, 0 failing, 1 pending.

## Note
An earlier RESULT.md commit sits before the comment commit on this branch; this final commit is the current report.

RUN-COMPLETE 3ce34520da92d3900d76dc478a2c7bde
