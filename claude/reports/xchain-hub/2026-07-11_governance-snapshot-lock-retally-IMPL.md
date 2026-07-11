# Governance R2-M2 + R2-H2 - IMPLEMENTED (uncommitted, awaiting deploy review)

**Date:** 2026-07-11  
**Design:** `2026-07-11_governance-snapshot-lock-retally-design.md` (approved: exact-set
snapshot validation, Phase-1 count-based tally, mainnet activation TBD).  
**Status:** code complete + tested, UNCOMMITTED. Consensus/governance code stops for user
review before any deploy (standing rule).

## What changed (all in `src/Governance.js` + schema + tests)

- **Schema** `src/sql/governance_proposals.sql`: new `validator_snapshot MEDIUMTEXT NULL`
  (drift-reconciler auto-adds it via `alterTableForDrift`, nullable+default so existing rows
  backfill safely).
- **R2-M2 snapshot-lock:**
  - `GOV_SNAPSHOT_ACTIVATION = {mainnet:null, testnet:0, regtest:0}` + `_isSnapshotLockActive()`
    (BTC-height gated, same discipline as SWQ; mainnet null => OFF until the flag-day height is set).
  - `propose()` captures `_buildValidatorSnapshot()` (pubkey-sorted `{pubkey,addr}`), persists it,
    broadcasts it on `GOV_PROPOSE` (`validatorSnapshot`).
  - `_handlePropose()` re-validates the wire snapshot exact-set vs the local registry
    (`_snapshotMatchesLocalSet`, fail-closed like the activation_block re-check). Snapshot-lock
    active + missing/mismatched snapshot => drop. Below activation => persist NULL (legacy).
  - `vote()` / `_handleVote()` gate membership on the locked snapshot when present (a validator
    registered after creation can't vote), else live set.
  - `_tallyProposal()` tallies via the shared `_computeTally(votes, electorate)` against the
    locked snapshot size, not `this.validatorSet.length`. Set churn mid-vote no longer moves the
    quorum/approval goalposts.
- **R2-H2 local re-tally:**
  - `_tallyProposal()` broadcasts `GOV_RESULT` with signed vote evidence (`votes[]`).
  - `_handleResult()` for a snapshot-locked proposal: `_ingestResultVotes()` (each vote
    re-verified: member of locked snapshot + ed25519 sig over the canonical payload, idempotent
    upsert), then re-tally locally via `_computeTally`, apply the LOCAL result, warn-log on
    wire/local mismatch. Kills the leader-grinding forged-`passed`-with-zero-approvals attack.
    Legacy NULL-snapshot rows keep apply-wire-status (why M2 gates H2).

## Tests / verification

`test/unit/Governance.test.js`: +13 tests (snapshot build/parse/exact-set; locked-denominator
tally immune to a 3->9 set churn; GOV_RESULT vote evidence; forged-pass overridden to failed;
missed-gossip recovery via signed evidence; non-member/bad-sig evidence rejected; legacy
wire-status path; propose persists+broadcasts snapshot; below-gate NULL persist; gate on
network+height). 3 existing stubs relaxed for the added `voting_end, validator_snapshot` SELECT.
**Governance suite 86 passing; full hub CI 2288 unit + 85 security, 0 failing, Node 22.**

## Deploy sequence (per design)

1. Roll this hub code fleet-wide (regtest -> test-host/test-host -> prod) with mainnet activation unset.
2. Set `GOV_SNAPSHOT_ACTIVATION.mainnet` in the flag-day batch after a fleet check confirms every
   hub is on this code (STATE_HASH lesson: whole fleet armed before activation).

## NOT done (deferred per design)

Stake-weighting (Phase 2: validators table has no stake column, governance has no capability
scope). Flag-day batch items (Oracle M1, S-F7, A-F6+EQUIV, R2-FN2, anchor_archive) remain.
