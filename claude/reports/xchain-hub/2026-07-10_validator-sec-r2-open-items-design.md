# Validator-sec R2 open items: verify-vs-HEAD + fix design

**Date:** 2026-07-10 (evening)  
**Scope:** every open item from the 2026-07-06 validator stress-test SoT
(`claude/reports/xchain-hub/2026-07-06_validator-stress-test-security-sweep.md`),
re-verified against xchain-hub HEAD `0e1f772` by 5 parallel review agents, each
finding re-checked by the coordinating session.  
**Status of this doc:** DESIGN ONLY. No consensus code has been written or shipped.
The one code change this session was a stale-test fix (below). Everything else is a
recommendation pending sign-off.

## TL;DR

Of the ~18 documented open items, **6 are already FIXED at HEAD** by work that
landed since 07-06 (reorg validity, the anchor cluster, one governance item), and
**12 remain OPEN**. The open items split cleanly by how they can ship:

- **Ship-now safe** (pure-local hardening, no wire/consensus-format change, a single
  hub protects itself, no fleet coordination): A-F5, A-F3, A-F4, R2-FN3, R2-CCF4,
  Oracle-L1, S-F6(docs). These are the stress-sweep's natural next fixes.
- **Consensus acceptance-rule change, rolling deploy** (no flag day, but protection
  scales with fleet coverage): A-F1 (HIGH, currently undeterred), R2-H2 (governance
  re-tally, depends on R2-M2 first).
- **Flag-day / wire-format** (coordinated fleet cutover, gate like SWQ/EQUIV): Oracle
  M1, S-F7, A-F6, R2-M2, R2-FN2, and the reward-derivation half of the anchor_archive
  residual.
- **Cross-service verify** (must read xchain-indexer / xchain-sync, out of hub scope):
  S-F5 slash-acceptance, XCALL retraction receive-side.

Recommended first three to implement: **A-F1** (HIGH, its only deterrent is inert),
then **A-F5 DEX/XCALL** (cheap, and worse than documented), then the governance pair
**R2-M2 then R2-H2** in that order.

## Already FIXED at HEAD (verified, no action)

| Item | Was | Fixed by | Evidence |
|---|---|---|---|
| R2-C2 reorg cryptographic validity | CRITICAL | 7d8ec4a (+200ac35/e2ffcda/e8923cc) | `ReorgHandler._digest` binds old/new hash; `reportReorg`/`_handleAlert`/`_handlePrepare` all `_verifyReorgAgainstOwnNode` before co-signing; quorum gated on `selfVerified`. |
| R2-AF1 anchor reward forge (V0_DONE) | HIGH | 1662fdd + 137c55c + 31b7475 | `_handleV0Done` gates on membership+sig, re-derived elected-publisher rank, and `_verifyAnchorOnChain(txid)` (DOGE indexer, confs>=threshold, payload-hash match) before stamp+reward. |
| R2-AF3/AF4 forged FINALIZED / V0 suppress | MED | 9325fca + 31b7475 | `_handleFinalized` gates on observed-elected-leader + `_verifyFinalizedAgainstLocal` (content re-check) + `_verifyArchiveCheckpointOnChain(txid, version)`. |
| R2-AF5 election live-registry fallback | LOW | e8923cc | `_getActiveOraclePublishPubkeys(blockIndex)` returns `[]` on a failed block-pinned snapshot instead of falling through to the live registry. |
| R2-H1 governance bounds inbound | HIGH | c8f0a1f | `_handlePropose` now calls `_validateChangeBounds` and drops on throw. |
| CrossChainEngine `_handlePropose` accept test | (stale test) | this session | See below. |

Residual on the anchor cluster (not a live hole): `RewardTracker.js:109`
`/^anchor_(BTC|LTC|DOGE)$/` still excludes `anchor_archive`, so its reward takes the
legacy `_pushRewardsToBtcIndexer` path rather than the on-chain-derived model. The
**forgery** vector is closed at the call site (only fires after the FINALIZED gates),
so this is hardening debt (LOW), not exploitable. Folding `anchor_archive` into the
derive path is a flag-day + indexer change; listed under flag-day below.

## Fixed this session (test-only, safe)

**Stale security test** `test/security/security.test.js` "_handlePropose accepts valid
attestation ID format" was failing at HEAD. Root cause: `CrossChainEngine._handlePropose`
now refuses to PREPARE over a 0 quorum (the R2-3 empty-snapshot fail-closed hardening),
and the test never stubbed a resolvable quorum, so `_resolveQuorum` returned 0 and the
propose was correctly dropped. This is a stale-vs-hardening test, same class as the 7
rotted assertions the SoT noted, NOT a code regression. Fixed by stubbing
`_resolveQuorum` to a real federation quorum so the test exercises the accept branch.
Hub CI now green: **2227 unit + 85 security, 0 failing**. UNCOMMITTED.

## OPEN items: design, by ship-class

### A. Ship-now safe (pure-local hardening; no wire/consensus-format change)

These change only what a single hub accepts or how it bounds its own memory. A hub can
adopt each independently; an un-upgraded peer interoperates unchanged. No flag day.

- **A-F5 (MED; MED-HIGH on DEX/XCALL): early-buffer before membership/size checks.**
  `AttestationConsensus._handlePropose/_handlePrepare/_handleCommit` buffer unconditionally
  when `!pending`, before any size gate, and `this.earlyMessages` has no cap on distinct
  `rid` keys (only 32/key). `CrossChainDexConsensus` (shared by DEX **and** XCALL) is worse:
  it has **no body-size gate at all**, even post-pending; a PROPOSE carries a full unbounded
  `row`. Fix: port the Oracle `_bufferEarlyMessage` pattern (apply the provider-agnostic
  `_maxBodyB64Length(undefined)`, ~91KB, cap before buffering; add an
  `earlyMessageMaxDistinctIds` FIFO cap; add a `JSON.stringify(d.row).length` bound to
  `CrossChainDexConsensus`). Mirrors the already-shipped `ORACLE_EARLY_MSG_MAX_ROUNDS` fix.
- **A-F4 (MED, liveness): byte_equality winner latch.** First validly-signed PREPARE sets
  `pending.winner` regardless of this hub's own `agree()`; a responsible Byzantine node
  starves every round it is in (safety holds, round times out). Fix: don't latch from a
  single inbound PREPARE. Require the follower's own `agree()` to have produced the same
  hash, or `>=2` distinct signers corroborating, before adopting.
- **A-F3 (LOW-MED, griefing): `_handleNewView` not quorum-gated.** `CrossChainDexConsensus._handleNewView`
  accepts `pending.view = view` after only the leader-for-view + control-sig checks, never
  testing `pending.viewChanges.get(view)` against `_meetsQuorum`. A Byzantine future-view
  leader forces honest nodes forward with no real view-change quorum (bounded by timeout).
  Fix: require `_meetsQuorum` on the locally-tracked `viewChanges` set before advancing;
  defer rather than reject if not yet met.
- **R2-FN3 (LOW-MED): full-node challenge leader can omit an honest claimant.**
  `FullNodeChallengeRound._onSignReq` validates only that listed claimants are valid, never
  that the PASS list is complete. Fix: verifier also requires `pass` to be a superset of its
  own locally-confirmed-correct set (`state.answers` matching `state.myAnswer`) before signing.
  Purely verifier-side; honest leaders unaffected.
- **R2-CCF4 (LOW): `CrossChainEngine.finalized` Set unbounded.** Only ever `.add()`'d.
  Sibling engines (`AttestationConsensus`, `CrossChainDexConsensus`) already carry a
  `finalizedMax` FIFO ring-buffer; apply the same here.
- **Oracle L1 (LOW): `OracleConsensus.finalized` Set unbounded.** Same class; age out
  entries below `currentRound - retentionWindow`, mirroring `_pruneEarlyMessages`.
- **S-F6 (INFO, docs): misleading `getActiveCount()` comment.** `CapabilityRegistry.getActiveCount()`
  doc says "used for PBFT quorum sizing" but filters on per-hub-local `self_test_ok`/`enabled`
  (0 callers); wiring it into a quorum path would fork the fleet. Correct the comment to point
  at `CapabilitySnapshot.getSnapshot`/`getQuorum` as the deterministic source. Latent-trap
  removal.

### B. Consensus acceptance-rule change, rolling deploy (no flag day; protection scales with coverage)

- **A-F1 (HIGH, currently UNDETERRED): judge_model leader-trust.** `AttestationConsensus._handlePrepare`
  judge_model branch sets `pending.winner` straight from the elected leader's claimed body,
  requiring only that the follower's own fetch was non-empty; it never checks the leader's
  body-hash against any of the `>=need` collected proposals. A Byzantine per-request leader
  injects an arbitrary response honest followers re-sign. **The only documented deterrent,
  AttestationSpotChecker, is inert**: synthetic-request injection was never built (its header
  says so), so there is zero automatic spot-check traffic today. Fix: before adopting the
  leader's winner, require `sha256(body)+meta` to match at least one entry in the follower's
  own `pending.proposals`; buffer the PREPARE if not enough proposals collected yet. No new
  signed fields (not a wire change), so a rolling deploy is safe, but coverage-dependent, so
  prioritize. **Recommended #1 to implement.**
- **R2-H2 (HIGH): GOV_RESULT applied without re-tally.** `Governance._handleResult` now
  authenticates the sender as the deterministic proposal leader (7dd29e6) but still applies
  the wire `status` without recomputing. A validator grinds `proposalId` (embeds `Date.now()`)
  to become its own proposal's leader, waits out the voting period, and broadcasts
  `passed` with zero approvals. Fix: treat the envelope as a liveness trigger only, re-tally
  locally from stored authenticated `governance_votes` and apply on the local result.
  **Depends on R2-M2** (see below); do M2 first.

### C. Flag-day / wire-format (coordinated fleet cutover; gate like SWQ / EQUIV)

- **Oracle M1 (MED): count-mode admits non-price validators.** Votes are gated by the general
  `_isKnownSender` registry, not membership in the price-qualified `pending.snapshot`; vote sets
  and the submission map key on `envelope.sender`, not verified pubkey. Fix: require the sender's
  resolved pubkey to be in `pending.snapshot.validators` before counting, and re-key
  `prepares`/`commits` by verified pubkey. Changes what counts toward finalization, so it must
  ship byte-identically fleet-wide behind an activation gate.
- **R2-M2 (MED): governance tally not snapshot-locked / not stake-weighted.** `_tallyProposal`
  uses live mutable `this.validatorSet.length` (churned by `setValidatorSet`), and never imports
  `stake_weighted_quorum` unlike every other consensus engine. Fix: persist a `validator_snapshot`
  (and stake weights) onto `governance_proposals` at creation, carried on `GOV_PROPOSE` and
  follower-revalidated (mirroring `activation_block`), and tally against it. Schema + wire +
  consensus change; flag-day-gated. **Do this before R2-H2**: H2's local re-tally is only
  fork-safe if all honest hubs count against the same locked denominator.
- **S-F7 (CAVEAT/MED): oracle snapshots at raw tip.** `OracleRound` anchors on `db.getChainTip('BTC')`
  with no confirmation margin, flowing into `getSnapshot('price', tip)`; a reorg within the round
  or the 60s cache TTL finalizes against a pre-reorg stake set. Sibling `StateCheckpointEngine` already
  uses `tip - confirmations`. Fix: subtract a margin (`ORACLE_SNAPSHOT_CONFIRMATIONS`) before the
  snapshot call. Every hub must compute the same anchor height, so coordinate.
- **A-F6 (LOW): PBFT phase not bound in signed payload.** PROPOSE/PREPARE/COMMIT share one canonical
  in DEX/XCALL and attestation; `equivocation_header.js` deliberately keys on `(engine, round, view)`
  only. Not exploitable today. Fix: thread a phase segment into `buildEquivCanonical` and both call
  sites, but this is byte-locked by `ConsensusPrimitiveConformance.test.js` across 5 repos. **Bundle
  into the next EQUIV-family flag-day batch**, do not ship standalone.
- **R2-FN2 (MED): full-node challenge answer copyable.** `FullNodeChallengeRound` broadcasts the
  plaintext answer and signs only `(challengeId, answer)`; a light mirror copies a peer's answer and
  re-signs with its own key to earn the full-node reward tier. Fix: commit-reveal (`SHA256(answer||nonce)`
  at open, reveal after collection-close) or bind the reveal to the claimant pubkey (`HMAC(answer,
  pubkey)`). New wire phase, so coordinate the deploy; ship before leaning harder on the full-node reward tier.
- **anchor_archive reward derivation** (LOW, debt): fold `anchor_archive` into the
  `ANCHOR_REWARD_ACTIVATION` derive path (or widen `RewardTracker.js:109` regex on its own flag-day) so
  the archive reward is indexer-re-derivable like `anchor_<CHAIN>`. Hub + indexer + docs coordinated.

### D. Cross-service verify (out of hub scope; read indexer / sync)

- **S-F5 (INFO, may escalate): slash evidence unsigned.** `SlashDetector._recordSlashProposal` writes
  `slash_proposals` with no signature over the evidence, and the hub has no cross-hub quorum-of-proposals
  logic. Whether the **indexer** slash-acceptance path requires `>=f+1` independently-derived matching
  proposals before slashing an honest validator cannot be seen from the hub. Action: verify the
  xchain-indexer slash path. If it accepts a single hub's unsigned row, escalate to MED/HIGH and sign
  the evidence (Ed25519) fleet-wide.
- **XCALL/DEX retraction unsigned (boundary).** `HubDbBroadcaster.broadcastDeletion` sends
  `row:deleted` with no signature/consensus_proof (additions carry a 2f+1 proof), triggered by a single
  `HUB_API_KEY`-gated RPC. Safety rests entirely on the receiver. Action: verify xchain-sync / xchain-indexer
  treat an unsigned deletion as a **hint to re-check** their own source-chain reorg view (and validate
  `retraction_generation` against their own last-observed rollback generation), not as ground truth. If
  they delete on the hub's say-so, a single compromised key erases relay rows fleet-wide, so escalate.

## Recommended implementation order

1. **A-F1** (HIGH, undeterred): local acceptance filter, rolling deploy.
2. **A-F5** DEX/XCALL + Attestation (MED / MED-HIGH): cheap, worse than documented, pure-local.
3. **R2-M2 then R2-H2** (governance, HIGH): snapshot-lock first, then re-tally; both flag-day/deploy-coordinated.
4. **Oracle M1** (MED): flag-day membership+pubkey gating.
5. Ship-now LOW cluster together: A-F4, A-F3, R2-FN3, R2-CCF4, Oracle-L1, S-F6.
6. Flag-day batch: S-F7, A-F6 (with EQUIV), R2-FN2, anchor_archive derive.
7. Cross-service pass: S-F5 indexer, XCALL retraction receiver.

## Notes on trust / method

- The Anchor agent reported `StateAnchorPublisher.test.js` red (14 failing) under
  `--timeout 0`. NOT reproduced under the project's standard invocation: `npm run ci`
  and `mocha --timeout 5000` both show **80 passing, 0 failing**. The failures were an
  artifact of the non-standard `--timeout 0` flag, not a HEAD regression. The four anchor
  fixes were verified by direct code reading, independent of the suite.
- Every OPEN item above was substantiated against current HEAD with file:line evidence;
  nothing was carried forward on the strength of the 07-06 report alone.
