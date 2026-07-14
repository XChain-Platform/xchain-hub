# Validator stress-test + security sweep (xchain-hub, 2026-07-06)

Goal: stress-test the validators (the xchain-hub consensus/federation layer) to
find and fix security issues, improve performance, and identify gaps.

Method: read-only audit of the crown-jewel consensus files by hand plus three
parallel opus auditors (Oracle, Attestation/DEX, Snapshot/Slashing), each
adversarial and told to report only concretely-traceable findings. Every
candidate was verified against current code (not memory), and every FIX was
proven by a runtime PoC and/or a new regression test.

Baseline before changes: `npm run ci` (test/unit) = **1945 passing**. Fuzz suite
green. After all fixes: **1950 passing, exit 0, zero regressions**; plus 5 new unit
tests and 3 new security tests. The 7 pre-existing `test/security` failures are
unrelated test rot (see Gaps).

Node 22.22.3 (required; 24 can't build isolated-vm, 18 fails mariadb ESM).

---

## FIXED (with tests, verified this session)

### P-1, CRITICAL: transport does not bind `envelope.sender` to the signing key, so one validator forges a full quorum / poisons the oracle median
`src/PeerManager.js` `_verifySignature` (Option A path).

The Option-A transport auth admits a signed envelope purely by `sig_pubkey`
**membership** in the effective-signer/registry set, then verifies the Ed25519
signature against that carried key. It never checks that `envelope.sender`
corresponds to `sig_pubkey`, and `_handleInbound` never enforces
`envelope.sender === ws._peerAddr` on later messages. Meanwhile the **count-mode**
PBFT tallies (Consensus, OracleConsensus) key their vote sets on `envelope.sender`,
and `OracleRound` dedups submissions by `envelope.sender`.

Count mode is the **live mainnet path** (`stake_weighted_quorum` activation is the
placeholder `999999999`; current BTC height ~950k). So a single Byzantine
validator holding ONE authorized key can:
- sign PREPARE/COMMIT/VIEW_CHANGE envelopes naming every OTHER validator's addr and
  reach 2f+1 alone (config PBFT and oracle PBFT), or
- emit up to `ORACLE_MAX_SUBMISSIONS_PER_ROUND` submissions under fabricated
  senders to fully control the trimmed median, which every honest hub then
  co-signs (its own local band matches the gossiped poison).

This defeats BFT on the live path. Independently found by both the by-hand review
and the Oracle auditor (C1/C2); the codebase already enforces the exact same
addr/pubkey binding for capability gossip (`XChainHub._handleCapabilityMessage`),
so the vote path was the outlier.

PoC (real Ed25519 keys): A's key signing envelopes as B and C both returned
`_verifySignature -> true` before the fix, `false` after.

Fix: after the signature verifies, require `validatorPubkeys.get(sender)`, when
present, to equal `sig_pubkey` (fail closed). A sender the registry doesn't know
still passes transport (rotation / relayed gossip origin) but its votes are
dropped downstream by `_isKnownSender`, so consensus attribution is always bound
to a registered key. The DEX/Attestation engines were NOT exposed (they tally the
inner `data.sig_pubkey` vote and check snapshot membership by pubkey).

Tests: `test/security/security.test.js` "PeerManager: Sender<->key binding" (3).
Rotation note: a chain-rotated key must be reflected in the registry (via
`syncvalidators`) for its sender attribution to be accepted. That is the safe,
fail-closed behavior; the effective-set alone is addr-blind and cannot safely
attribute a vote to an addr.

### F-2, MEDIUM: DEX/XCALL empty capability snapshot collapses to quorum 0, causing unilateral single-sig finalize + permanent order wedge
`src/CrossChainDexConsensus.js` `propose()`.

`quorum = (snapCount <= 1) ? 0 : …` conflated **0 validators** (empty snapshot:
bootstrap/mirror-lag read, or seed-local off) with **1 validator** (single
operator). On an empty snapshot the hub self-signed and finalized a 1-sig match
that peers with a populated snapshot never ratify, so the `match_id` lands in
`finalized` (never re-proposed) and this hub's committed ledger forks. (Attestation
does not have this bug; it rejects an empty snapshot before proposing.)

Fix: only take the quorum-0 fast path when the snapshot's sole validator is THIS
hub's own pubkey; otherwise abort the round (delete pending, log) so discovery
re-proposes when the snapshot populates. Covers both DEX and XCALL (shared engine).
Tests: `test/unit/CrossChainDexConsensus.test.js` (2, incl. the N=1 self path still
finalizes).

### F-1, MEDIUM: `getQuorum` string count explodes quorum, causing permanent consensus halt (DoS)
`src/CapabilitySnapshot.js` `getQuorum()`.

`N = snapshot.count` was used raw from indexer JSON. If serialized as a STRING,
`Math.ceil((N + 1) / 2)` string-concatenates (`"5" + 1 -> "51"`), giving quorum
26-of-5, a deterministic halt across the federation. `PriceAggregator` already
`parseInt`s this field defensively; `getQuorum` was the one consensus path that
didn't.

Fix: `N = Number(snapshot.count)`, falling back to the deduped membership-set size
when count isn't a sane integer (so a malformed count can't drop quorum to a
single-node bypass). Tests: `test/unit/CapabilitySnapshot.test.js` "getQuorum()" (2).

### S-F3, MEDIUM: null `min_stake` from a live registry silently forks the qualifying set
`src/CapabilitySnapshot.js` `getSnapshot()` / `getWeightSnapshot()`.

`_resolveMinStake` returned null both when the registry was not yet wired
(transient, pre-startCapabilities) AND when a known capability had no configured
threshold (permanent: missing from HUB_CAPABILITY_CONFIG). In the second case the
snapshot omitted `min_stake` and each indexer fell back to its OWN local threshold,
which can drift between independently-operated indexers, so two hubs qualify
different validator sets for the same round and fork.

Fix: the registry seeds genesis thresholds synchronously in its constructor, so a
null threshold from a LIVE registry (`_registryReady()`) means the capability is
unconfigured. In that case fail closed (return null snapshot, loud throttled error)
instead of omitting the field. The genuine pre-startup window (registry object
absent) still omits and lets the indexer fall back, since no consensus rounds run
then. Tests: `test/unit/CapabilitySnapshot.test.js` (2 fail-closed + the preserved
pre-startup omit).

### PERF/DoS: Oracle `earlyMessages` had no cap on distinct round keys
`src/OracleConsensus.js` `_bufferEarlyMessage()`.

`round` is attacker-controlled; a Byzantine validator streaming PREPAREs with
millions of fresh round numbers inside the 60s TTL grew `earlyMessages` without
bound (heap DoS) and made every `_pruneEarlyMessages` an O(rounds) scan (O(n^2)).

Fix: cap distinct buffered rounds (default 256, env `ORACLE_EARLY_MSG_MAX_ROUNDS`)
with FIFO eviction of the oldest round key. Bounds memory to maxRounds x 64
envelopes and the prune scan. Test: `test/unit/OracleConsensusEarlyBuffer.test.js` (1).

---

## IDENTIFIED, recommend follow-up (not fixed; risk/coordination or lower severity)

Oracle:
- **M1 (MEDIUM)** count-mode oracle admits ANY registered validator toward a quorum
  sized from the `price` capability snapshot; a non-price validator's votes count.
  Also submission map keyed by `sender`, not verified pubkey. The P-1 fix closes the
  amplification; membership-gating (`pending.snapshot`) and re-keying by pubkey still
  recommended. `OracleConsensus.js` ~504-509, 738/777/797.
- **L1 (LOW)** `finalized` Set never pruned (about 1 entry / 10 min, process-lifetime).

Attestation / DEX:
- **A-F1 (HIGH, documented tradeoff)** judge_model finality trusts the elected
  leader's body verbatim; the deterministic per-request leader can inject an
  arbitrary response honest followers re-sign. Deterred only by AttestationSpotChecker
  plus slashing. Tighten by requiring the leader's body to hash-match one of the
  >=need collected proposals. `AttestationConsensus.js` ~457-460, 514-593.
- **A-F4 (MEDIUM, liveness)** byte_equality winner is latched by the first PREPARE and
  never reset; one Byzantine responsible node deterministically starves every
  byte_equality round it is in (safety holds; request expires + refunds). Derive the
  winner only from locally-run agree(), or require >=2 matching bodies.
- **A-F5 (MEDIUM, DoS)** DEX/XCALL early-message buffering happens before
  membership/size checks; same class as the Oracle fix above. Apply the
  `_maxBodyB64Length` gate plus a distinct-id cap before buffering.
- **A-F3 (LOW-MED, griefing)** DEX/XCALL `_handleNewView` is not gated on a
  view-change quorum; a Byzantine node can force honest nodes to a future view it
  already leads (bounded; one timeout advances past it).
- **A-F6 (LOW, not exploitable)** PBFT phase not bound in the DEX/attestation signed
  payload (PREPARE and COMMIT interchangeable); add a phase tag for defense-in-depth.

Snapshot / Slashing:
- **S-F3 (MEDIUM, silent fork): FIXED this session (see above).**
- **S-F4 (LOW-MED)** non-participation is a consecutive-miss counter reset on ANY
  single participation; a validator participating 1-in-30 rounds evades slashing
  forever. Use a windowed participation-rate check.
- **S-F5 (INFO)** slash evidence is not signature-bound; verify the indexer slash-
  acceptance path requires a quorum of independently-derived proposals (not one hub's
  row) before slashing an honest validator.
- **S-F6 (INFO, latent trap)** `CapabilityRegistry.getActiveCount()` doc-comment says
  "used for PBFT quorum sizing" but filters on per-hub-local `self_test_ok`/`enabled`
  (0 callers today); wiring it into a quorum path would instantly fork the federation.
  Correct the comment.
- **S-F7 (CAVEAT)** near-tip snapshots can serve a pre-reorg stake set for up to the
  60s TTL; confirm consensus callers snapshot at a buried depth, not tip.

---

## GAPS

- **CI coverage:** `npm run ci` runs ONLY `test/unit`. `test/security`,
  `test/regression`, and `test/performance` are not gated. `test/security` has **7
  rotted assertions** (the oracle price sanity upper bound was widened to ~1e12; old
  tests still expect a 10,000,000 cap). `test/performance/*.perf.test.js` are mostly
  pending stubs. Recommend wiring security+regression into CI and de-rotting, and
  implementing the perf stubs (p2p flood, oracle load) so throughput regressions and
  the DoS bounds above are measured.
- **Weighted-quorum path is untested in production** because activation is a
  placeholder; the count path (more exposed, P-1) is what actually runs on mainnet.
  The stake-weighted path is byte-identically vendored + conformance-gated and was
  found sound by all three auditors, but it has no live soak.

---

## ROUND 2 (second pass, same day): engines not covered in round 1

Three more opus auditors (Reorg/Governance, Anchor/Checkpoint, XCALL/Attestation/
FullNode) plus a by-hand pass over the EQUIV canonical, the DB layer, and the
external-fetch providers. This surfaced a NEW critical (Governance vote auth) plus a
cluster of high/medium consensus bugs.

### FIXED (with tests, 1968 unit passing, zero regressions)

**R2-1, CRITICAL: Governance inbound votes were unauthenticated.**
`src/Governance.js` `_handleVote`. Inbound GOV_VOTE was persisted with NO
`_isKnownSender`, NO signature check, and NO binding of the payload `voterPubkey`
to a real validator. The table is keyed by (proposal_id, voter_pubkey), so ONE
Byzantine validator that passes the transport sig layer could insert a row per
FABRICATED pubkey and single-handedly meet quorum + 2/3 approval, passing any
proposal federation-wide. Fix: authenticate the vote by its OWN signature (like the
PBFT engines): require voterPubkey to be a validator-set member AND the ed25519
signature to verify over the canonical vote payload (byte-identical to what `vote()`
signs). An attacker can now only cast its one legitimate vote. Also gated
`_handlePropose` on `_isKnownSender` (H-3: unbounded proposal-row DoS). Tests:
Governance.test.js (member+valid-sig persists; fabricated pubkey / forged sig /
unsigned all rejected).

**R2-2, HIGH: Anchor V0_DONE / FINALIZED membership check was fail-OPEN on an empty set.**
`src/StateAnchorPublisher.js` `_handleV0Done`, `_handleFinalized`. `if(pubkeys.length
&& !pubkeys.includes(sender))` admitted ANYONE when the oracle_publish set resolved
empty (startup / registry hiccup). Since `d.sig_pubkey` is self-asserted and the sig
is verified against it, membership was the ONLY tie to a federation member, so on an
empty set a forged V0_DONE could stamp a bogus anchor_txid (suppressing the real DOGE
anchor) or a forged FINALIZED could strand real matches as archived. Fix: fail closed
(`pubkeys.length === 0 || !pubkeys.includes(sender)`) on both handlers.

**R2-3, MEDIUM: CrossChainEngine finalized a swap attestation unilaterally over an empty snapshot.**
`src/CrossChainEngine.js` `requestAttestation`. Same empty-snapshot quorum-0 collapse
fixed for the DEX, still live in the attestation initiator path (worse: no source-
action verification on that branch). Fix: refuse when a cross_chain snapshot resolved
but is empty (federation bootstrap/misconfig); keep the genuine single-node fast path.
Test: CrossChainEngine.test.js.

**R2-4, LOW (hardening): http_get SSRF guard missed IPv4-embedding IPv6.**
`src/providers/http_get.js`. The attestation `http_get` provider (fetches
contract-supplied URLs) blocked private/loopback/metadata but not NAT64
(`64:ff9b::/96`) or IPv4-compatible (`::a.b.c.d`) IPv6, which smuggle an internal
IPv4 on a host with a NAT64 gateway. Fix: fail closed on any `::`-prefixed
(non-global-unicast) or `64:ff9b:` address. Test: http_get_provider.test.js.

### IDENTIFIED round 2 (NOT fixed; need coin-node wiring / careful design + integration tests)

Reorg:
- **R2-C3 (CRITICAL): rollback blast radius bounded. FIXED this session (partial).**
  `_executeRollback` DELETEs attestations and disputes price_snapshots WHERE time >
  FROM_UNIXTIME(timestamp/1000); `timestamp` was caller-chosen and only lower-bounded
  by 0, so `timestamp=1` wiped essentially everything for the chain. Fixed:
  `ReorgHandler` now rejects a reorg whose timestamp is older than
  `REORG_MAX_LOOKBACK_MS` (default 24h) or too far future, at every acceptance point
  (reportReorg throws; `_handleAlert`/`_handlePrepare` refuse to start/co-sign a round),
  so an honest majority denies a stale-timestamp rollback quorum. This BOUNDS the damage
  an unverified reorg can do (to recent state); it does not fully verify the reorg
  (see R2-C2). Tests: ReorgHandler.test.js + reorgHandler.boundary.test.js.
- **R2-C2 (CRITICAL, STILL OPEN): reorg consensus has no cryptographic VALIDITY check.**
  An honest hub PREPARE/COMMITs a REORG_ALERT without consulting its own coin node, so
  one Byzantine reporter can still drive a fabricated rollback of RECENT state (now
  bounded by R2-C3). Full fix: the reporter must carry old/new block hashes at the reorg
  height and each hub must verify against its own node/indexer (block hash at height
  changed) before contributing a PREPARE, binding the digest to the observed hashes. A
  follower-side reorg-height plausibility check (reorgHeight near the hub's own chain
  tip) was scoped but deferred: it requires converting the sync inbound handlers to async
  (db.getChainTip), which changes their contract and needs integration testing on a live
  regtest reorg. Recommend designing R2-C2 with that async conversion + a cross-service
  reorg-proof wire format together.

Governance (built on R2-1):
- **R2-H1 (HIGH): change bounds (+50%/-33%) enforced only on local propose, not inbound.**
  `_handlePropose` never calls `_validateChangeBounds`. Re-check inbound proposals.
- **R2-H2 (HIGH): GOV_RESULT applied without re-tally.** `_handleResult` trusts the
  leader's asserted `status`; a proposer grinds `proposalId` (embeds Date.now()) to
  make itself tally-leader and declare `passed` with zero real approvals. Fix: re-tally
  locally from stored (now-authenticated) votes and apply only on agreement.
- **R2-M2 (MEDIUM): tally denominator is count-based and not snapshot-locked.** Snapshot
  the validator set + stake weights into the proposal at creation and tally against that
  (a `_tallyProposal` member-filter was prototyped this round but reverted: it broke the
  count-based boundary suite and is subsumed by the proper snapshot-locked fix).

Anchor:
- **R2-AF1 (HIGH): oracle_publish member mints/steals anchor rewards via forged XANC_V0_DONE.**
  `_handleV0Done` records a reward keyed on wire `checkpoint_seq`/`chain` with no check
  the anchor exists on DOGE or that seq matches the local checkpoint. R2-2 closes the
  external/empty-set vector; a real member forging its OWN rewards remains. Fix: bind
  the reward to verifiable on-chain state (or derive rewards only from the quorum path)
  and cap rows per (sender, chain).
- **R2-AF3/AF4 (MEDIUM)**: forged FINALIZED strands matches as archived; pre-emptive
  forged V0_DONE suppresses the only anchor. R2-2 narrows both to members; full fix
  requires tying FINALIZED/txid to a co-signed batch the receiver verified.
- **R2-AF5 (LOW)**: election falls back to the live (non-block-scoped) registry on a
  snapshot read failure, so two honest hubs can elect different publishers and
  double-spend DOGE (not a fork). Treat a failed block-scoped resolve as abstain.

XCALL / FullNode:
- **R2-FN2 (MEDIUM): full-node possession challenge answer is copyable.** The answer is
  broadcast in plaintext; a light-mirror validator copies a peer's XNODE_ANSWER, signs
  with its own key, and earns the full-node reward tier without running a node. Fix:
  commit-reveal or a per-validator secret challenge.
- **R2-FN3 (LOW-MED)**: an elected challenge leader can omit an honest claimant from the
  PASS list (verifiers check listed-claimant validity, not completeness).
- **R2-CCF4 (LOW)**: `CrossChainEngine.finalized` Set is never pruned (slow unbounded growth).
- **Boundary**: XCALL retraction / mirror-deletion is broadcast UNSIGNED (only additions
  carry a 2f+1 proof); safety rests on the receiving indexer independently observing the
  same source reorg. Verify that receive-side check in xchain-sync/indexer.

### Round 2 defended (verified sound, no action)
XCALL confirmation gates + follower re-verification at depth; XCALL/DEX signature phase/
round binding; AttestationRound responsible-set selection (staked identity, empty-set
skip, no grind); FullNode PASS quorum is verifier-recomputed; anchor follower byte-
verification of archives (re-derives every field, gzip-bomb bounded, quorum-checks
archived sigs); anchor failover ladder monotonicity; checkpoint hash/replay binding;
governance bounds arithmetic (exact BigInt); reorg quorum floor + addr-keyed vote sets;
SQL is fully parameterized (no injection); claude-spawn uses no shell (no cmd injection);
EQUIV canonical matches by literal `||` boundary (no field-split), parseInt fails safe.

---

## Files touched
- src/PeerManager.js (P-1)
- src/CapabilitySnapshot.js (F-1)
- src/CrossChainDexConsensus.js (F-2)
- src/OracleConsensus.js (early-buffer cap)
- test/security/security.test.js (+3)
- test/unit/CapabilitySnapshot.test.js (+2)
- test/unit/CrossChainDexConsensus.test.js (+2)
- test/unit/OracleConsensusEarlyBuffer.test.js (+1)
- claude/scratch/poc-sender-forgery.js (PoC probe; gitignored)

Round 1 fixes are COMMITTED + PUSHED (2b61da0, 21af061, 1b4bcbf, b326def, 6481399).

Round 2 files (uncommitted):
- src/Governance.js (R2-1 vote auth + propose gate)
- src/StateAnchorPublisher.js (R2-2 fail-closed membership x2)
- src/CrossChainEngine.js (R2-3 empty-snapshot refusal)
- src/providers/http_get.js (R2-4 SSRF NAT64/v4-compat)
- test/unit/Governance.test.js (vote-auth tests)
- test/unit/CrossChainEngine.test.js (+1)
- test/unit/http_get_provider.test.js (+1)
- test/unit/StateAnchorPublisher.test.js (harness registry mock for fail-closed)
- src/ReorgHandler.js (R2-C3 blast-radius bound)
- test/unit/ReorgHandler.test.js + test/unit/boundary/reorgHandler.boundary.test.js

P-1 (round 1) is consensus-affecting on the LIVE mainnet count path and should ship
with fleet coordination (fail-closed, preserves normal operation). R2-1 (governance
vote auth) is also consensus-affecting but fail-closed and honest-path-safe.

TOP OPEN (urgent): R2-C2 (reorg has no cryptographic validity check) is the highest
remaining risk. R2-C3 now bounds the blast radius to recent state, but a Byzantine
reporter can still force a rollback of that recent state until each hub verifies the
reorg against its own coin node (needs a reorg-proof wire format + async handler
conversion + regtest integration testing).
