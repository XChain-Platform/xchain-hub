# Governance hardening design: R2-M2 (snapshot-locked tally) + R2-H2 (local re-tally)

**Date:** 2026-07-11  
**Status:** DESIGN, awaiting sign-off (no code written)  
**Scope:** `xchain-hub` `src/Governance.js`, `src/sql/governance_proposals.sql`, GOV_PROPOSE / GOV_RESULT wire  
**Order constraint:** M2 ships fleet-wide BEFORE H2 activates. H2's local re-tally is only fork-safe when every honest hub counts against the same locked denominator.

Both items are flag-day / deploy-coordinated per the 2026-07-10 open-items design doc. `Governance.js` is clean at HEAD (not in the second-coder WIP set), so implementation is unblocked once this design is approved.

## The two findings, restated

- **R2-M2 (MED):** `_tallyProposal` divides by live mutable `this.validatorSet.length` (churned by `setValidatorSet` at any time), and Governance is the only consensus engine that never imports `stake_weighted_quorum`. A set churn between propose and tally silently moves the quorum and 2/3 goalposts; validator-set growth mid-vote can retroactively fail a proposal that had 2/3 of the set it was proposed to (and vice versa on shrink).
- **R2-H2 (HIGH):** `_handleResult` authenticates the sender as the deterministic proposal leader (7dd29e6) but then applies the wire `status` verbatim, never recomputing. Since `proposalId = 'gov:' + parameter + ':' + Date.now()`, a Byzantine validator grinds the timestamp until `sha256(proposalId) % N` selects itself as leader, proposes, waits out the window, and broadcasts `passed` with zero approvals; every follower records it and emits `proposal:finalized`.

## R2-M2 design: snapshot-lock the electorate onto the proposal

### Schema (additive; drift-reconciler auto-adds, so ALTER must be IF NOT EXISTS)

`governance_proposals` gains one column:

```sql
validator_snapshot MEDIUMTEXT NULL DEFAULT NULL
```

JSON array, sorted by pubkey, captured at propose() time:

```json
[{"pubkey":"<64hex>","addr":"...","source":"<stake source id>","weight":"<decimal string>"}, ...]
```

`source`/`weight` are present only when a stake snapshot is resolvable (see "Stake weights" below); otherwise entries are `{pubkey, addr}` and the tally stays count-based over the locked set. NULL column = legacy proposal, tallied by today's live-set rule (backward compatible; no backfill).

### propose() path

1. Build the snapshot from `this.validatorSet` at creation time (the same membership source `vote()`/`_handleVote` gate on today), sorted by pubkey.
2. Persist it in the INSERT; broadcast it on GOV_PROPOSE as a new `validatorSnapshot` field (additive; old hubs ignore unknown fields).

### _handlePropose (follower) re-validation, mirroring the activation_block pattern

A follower must not trust the proposer's snapshot blind (a Byzantine proposer would ship a 1-member snapshot containing only itself). Accept the wire snapshot only if ALL of:

- It is a well-formed array of `{pubkey, ...}` with unique pubkeys, size <= a hard cap (e.g. 1000) and total serialized size <= e.g. 256 KB (DoS bound on the persisted row).
- **Every snapshot member is a currently-registered validator on this hub** (subset of local `validatorSet` by pubkey).
- **Snapshot covers the follower's own current set**: every pubkey in the follower's local `validatorSet` is present in the snapshot. Together with the subset rule this forces snapshot == follower's set (as a set), tolerating zero divergence. Since `setValidatorSet` is fed from the same `validators` table on every hub and churn is rare/administrative, honest proposals pass; any mismatch (including the 1-member attack) is dropped with a warn log, exactly like a too-soon activation_block. If real-world churn skew ever causes spurious drops, the observed symptom is a dropped proposal log line, and the proposer simply re-proposes; fail-closed is the right default for an electorate definition.
- Weights, if present, are non-negative decimals with non-blank sources (pre-validating what `stake_weighted_quorum` hard-errors on).

A GOV_PROPOSE with NO `validatorSnapshot` field: before the activation gate (below), accepted as legacy; after activation, dropped (warn) so no unlocked proposal can enter the post-flag-day electorate.

### Tally + vote gating against the snapshot

- `vote()` / `_handleVote`: membership check moves from live `validatorSet` to the proposal's stored snapshot (fallback to live set for legacy NULL-snapshot rows). This also closes the adjacent gap where a validator registered mid-vote can vote on a proposal it wasn't part of the electorate for.
- `_tallyProposal`:
  - `validatorCount` = snapshot length (legacy rows: live set, unchanged).
  - Count votes only from snapshot members (defense in depth; `_handleVote` already gates).
  - **Stake-weighted path:** if every snapshot entry carries a weight AND `swq.isStakeWeightedQuorumActive(anchorBlock, network)` (anchor = the proposal's `activation_block` when present, else the BTC tip observed at propose(), persisted alongside, see open question 2), pass = `swq.meetsStakeThreshold(snapshotEntries, approverPubkeys)` (>= 2/3 of locked stake approving; this subsumes the participation quorum). Otherwise: today's count rule, `totalVotes >= ceil(N/2)` and `approvals >= ceil(N*2/3)`, with N = snapshot size.

### Stake weights: source

The `validators` registry table has no stake column; every other engine resolves stake through `CapabilitySnapshot.getWeightSnapshot(capability, block)`. Governance has no natural capability scope. Recommendation: **Phase 1 ships the snapshot-lock count-based** (entries are `{pubkey, addr}` only); stake-weighting is wired but dormant until a governance stake source is designated (likely the union/general weight snapshot, a product decision). The R2-M2 finding's core is the unlocked denominator; count-over-locked-set already fixes that. This also avoids touching `CapabilitySnapshot.js`, which currently carries second-coder WIP.

### Activation gate

Per-network BTC-height constant in Governance.js, same shape as `STAKE_WEIGHTED_QUORUM_ACTIVATION`:

```js
const GOV_SNAPSHOT_ACTIVATION = { mainnet: <TBD, set at flag-day scheduling>, testnet: 0, regtest: 0 };
```

Evaluated against the hub's observed BTC tip at propose()/`_handlePropose` time. Below the gate: hubs still ATTACH and PERSIST snapshots (harmless, additive) but tally by the legacy rule and accept snapshotless proposals; at/above the gate: snapshot is required and is the tally rule. This gives a clean rolling deploy: code can go out fleet-wide any time, behavior flips together at the anchor height. Mainnet height chosen with the flag-day batch (Oracle M1, S-F7, A-F6, R2-FN2, anchor_archive) per the coordination plan.

## R2-H2 design: GOV_RESULT becomes a liveness trigger, not an oracle

### _handleResult changes (activation-gated, applies only to snapshot-locked proposals)

Keep the existing gates (known sender, leader-pinned, voting_end passed, status='voting' guard). Then, instead of applying the wire `status`:

1. **Ingest the leader's vote evidence** (see wire change below): for each vote in the envelope not already stored locally, verify membership in the row's snapshot + the ed25519 signature over the canonical vote payload (byte-identical to `vote()`/`_handleVote` verification), and upsert into `governance_votes`. This closes the gossip-skew hole: a follower that missed GOV_VOTE broadcasts can still reproduce the leader's tally from self-authenticating evidence.
2. **Re-tally locally** with the same function `_tallyProposal` uses (extract the pure tally into `_computeTally(proposal, votes)` so leader and follower share one implementation), against the row's `validator_snapshot`.
3. Apply the LOCAL result. If it disagrees with the wire `status`, log loudly (`Governance: GOV_RESULT status mismatch from leader <addr> on <proposalId>: wire=<s> local=<s'>`) and apply the local one. A ground-out leader's forged `passed` with no votes now applies as `failed` on every honest follower.
4. Emit `proposal:finalized` only when the LOCAL result is `passed` (same transition guard as today).

Legacy (NULL-snapshot) proposals keep today's apply-wire-status behavior; re-tallying them against a live set that differs per hub is exactly the fork H2 must not create, which is why M2 gates H2.

### Wire change (additive)

`GOV_RESULT` gains `votes: [{voterPubkey, vote, signature}, ...]` emitted by `_tallyProposal` from its own `governance_votes` read. Size-bounded by the snapshot cap (<= 1000 entries, each ~200 bytes). Old hubs ignore the field. A GOV_RESULT arriving WITHOUT `votes` on a snapshot-locked proposal is still re-tallied from local votes only (step 2), never applied blind.

### Residual risk after both land

- A Byzantine LEADER can still withhold GOV_RESULT (liveness, not safety; the proposal sits in 'voting'). Pre-existing, unchanged. A follower-side expiry sweep is out of scope here.
- Vote-withholding by the leader (broadcasting a subset of votes) cannot flip an outcome to `passed` (followers verify signatures and re-tally; missing approvals only push toward `failed`, and honest voters' GOV_VOTE gossip already reached most followers). A leader suppressing approvals to force `failed` is equivalent to today's leader just declaring `failed`, but is now DETECTED (mismatch log) on any follower holding the fuller vote set.

## Deploy / rollout plan

1. Implement M2 + H2 together in one hub change (H2's re-tally path is dead code below the activation gate, so co-shipping is safe); tests below.
2. Roll the hub fleet-wide (regtest -> test-host/test-host -> prod) with the mainnet activation height unset-high or TBD.
3. Set/confirm `GOV_SNAPSHOT_ACTIVATION.mainnet` in the flag-day batch alongside Oracle M1 / S-F7 / A-F6 / R2-FN2, after fleet check confirms every hub is on the new code (same discipline as the STATE_HASH lesson: whole fleet armed before each activation).

## Test plan (unit + security, `npm run ci` flags)

- propose() persists a sorted snapshot; GOV_PROPOSE carries it.
- `_handlePropose` drops: 1-member self-snapshot, snapshot missing a locally-known validator, oversized snapshot, malformed weights; accepts an exact-set match.
- Post-gate: snapshotless GOV_PROPOSE dropped; pre-gate: accepted legacy.
- Tally denominator: validator churn after propose() does not change the outcome (the R2-M2 regression proper).
- `_handleVote` rejects a validly-signed vote from a validator registered after propose() (not in snapshot).
- H2: forged `passed` from a ground leader with zero stored approvals applies as `failed`, no `proposal:finalized`; GOV_RESULT vote-evidence ingestion recovers a follower that missed all GOV_VOTE gossip; mismatch log on wire/local disagreement; legacy NULL-snapshot rows keep wire-status behavior.
- Shared `_computeTally` used by both paths (no drift).

## Open questions for sign-off

1. Follower snapshot validation: exact-set match (recommended, fail-closed) vs subset-only with a size floor? Exact-match can spuriously drop proposals during a registration race; the cost is a warn log + re-propose.
2. Stake-weighting: agree to defer (Phase 1 count-based over the locked set), or designate a stake source now? If now: which weight snapshot scopes governance?
3. `GOV_SNAPSHOT_ACTIVATION.mainnet` height: pick with the rest of the flag-day batch, or arm testnet/regtest first and leave mainnet TBD (recommended)?
