# Lane report: cx-xc-5959

## Files touched
- src/anchor/publisher/archive/checkpoint_price/checkpoint_price_verify.js (comment only: the note claiming a self-finalized row keeps an orphaned landing's stamp is stale after the earlier fix)
- Earlier commit already on the base (b6222def): src/db/prices/index.js, src/oracle/price_aggregator/batch_ingest.js, src/oracle/price_aggregator/retract.js, src/peers/hub_db/price_round_groups.js

## Tests
No test commands were run: the checkout has no node_modules, and the network policy for this lane did not install dependencies. 0 pass, 0 fail.

## Blocker: the requested hub test cannot be committed inside Surfaces
The review asks for a hub test (stamp a self-finalized row from a landing, roll the landing back, re-land at a later clock, two hubs end with equal batch_block_time, verifyArchivedPriceGroup co-signs the leader's row). Every test path is outside the six Surfaces, and the contract refuses any commit outside them, so I did not add one. Suggested home: test/unit/oracle/price/aggregator/batch/price_aggregator_batch_landing_time.test.js (it already builds signed batches, a mock hub and stampBatchLanding), plus a retract case next to it. The orchestrator should widen Surfaces to that test directory for a follow-up lane.

## On the "archive verify files are untouched" finding
Partly wrong. verifyArchivedPriceGroup compares the full serialized row (batch_block_time included) and finalized_apply compares status and batch_block_time. Both are correct once the two hubs hold equal rows; the defect was that the follower hub kept the orphaned clock. The retraction reset in retract.js plus the landing-source stamp removes that divergence at its source, so no logic change in the verify files is needed. Only the stale comment was edited. This is argued from reading the code, not demonstrated by a run.

RUN-COMPLETE 9e0435dca739175a383b7471bb89b952
