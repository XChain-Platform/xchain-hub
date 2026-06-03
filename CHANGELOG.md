# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `src/db.js` — `verifyTables()` now reconciles column drift on existing tables at startup (new `parseExpectedColumns()` / `alterTableForDrift()` helpers). Each table's live columns are compared against its SQL source and any column present in the source but missing from the live table is added with `ALTER TABLE ... ADD COLUMN`, reusing the source definition so its `DEFAULT` clause backfills existing rows; a `NOT NULL` column with no `DEFAULT` is skipped with a warning rather than aborting startup, and nullability drift is relaxed in the safe direction only (`NOT NULL` → `NULL`). Previously an already-existing table was never column-reconciled, so a column added to a schema after a hub was first installed was never applied on upgrade and any query referencing it failed with a hard `Unknown column` error. Fresh installs are unaffected.

### Changed
- `src/OracleConsensus.js` — the round-skipped log now states *why* a round was skipped. `_storeSkippedRound()` takes a `reason` argument that each call site supplies (`'no submissions'`, `'below minimum submissions threshold'`, `'aggregation yielded no prices'`) and interpolates into the log line (`Oracle: Round N skipped (<reason>)`). Previously the message was hardcoded to `(no submissions)` regardless of the actual cause, so a quorum shortfall (submissions present but below `ORACLE_MIN_SUBMISSIONS`) or an empty-aggregation result was indistinguishable from a genuine zero-submission outage in the logs. The stored `price_snapshots` row (`status = 'skipped'`) is unchanged; this is a log-message-only change with no schema or API impact.
- `src/OraclePublisher.js` — the oracle publisher constructor now reads `queuePath` and `maxAttempts` from `hub.p2pConfig` as a fallback when the corresponding environment variables are unset, matching the dual-read (`process.env.* || cfg.* || default`) pattern already used by `AttestationPublisher`. Previously `this.queuePath` came only from `process.env.PUBLISHER_QUEUE_PATH` and `this.maxAttempts` only from `process.env.PUBLISHER_MAX_ATTEMPTS`, so in multi-hub deployments where `p2pConfig` is the canonical configuration surface neither value could be set programmatically — the oracle publisher silently fell back to its hardcoded defaults (`./data/publisher-queue.jsonl`, `5`) regardless of what `p2pConfig` declared. The change is purely additive: the environment-variable path is unchanged, so operators configuring via env vars are unaffected; only the previously-missing `cfg.PUBLISHER_QUEUE_PATH` / `cfg.PUBLISHER_MAX_ATTEMPTS` fallback layer is new.
- `src/sql/validators.sql`, `src/XChainHub.js` — the `validators.chains` column (comma-separated supported chains for cross-chain quorum) is now declared in the schema file and added by the startup column-drift reconciliation, replacing the ad-hoc inline `ALTER TABLE validators ADD COLUMN chains ...` that `_loadChainPairValidators()` previously issued (and swallowed) on every call. Behavior is unchanged — the column is still guaranteed present before the validators are read — but the one-off DDL-on-read workaround is removed now that the generic drift check covers it.

### Fixed
- `src/OracleConsensus.js` — the oracle round now survives a round leader that crashes after recording its submission but before broadcasting `ORACLE_PROPOSE`, instead of stalling for the full finalization window. The deterministic round leader (`round % N`) is expected to aggregate the submissions and propose; followers wait for its PROPOSE. The existing fallback-proposer path only engaged when the leader had **no** submission on record, so a leader that gossiped its submission (making every hub see `leaderSubmitted === true`) and then crashed before proposing left every follower waiting until the 120s finalization timeout — discarding that round's pricing data and forcing the next round to start fresh. A shorter leader-timeout (default 30s, `ORACLE_LEADER_TIMEOUT_MS`) is now armed by the lowest-address submitter **other than** the leader once the round becomes ready to finalize: if no PROPOSE has populated `pendingRounds` by then, that node takes over as fallback proposer and salvages the round. Because a live leader proposes immediately, the takeover self-aborts whenever a PROPOSE arrives during the grace, so a healthy leader is never usurped. The receive side is relaxed to match: `_handlePropose` now accepts a fallback PROPOSE from the lowest-address non-leader submitter even when the leader is present in the local submission set, but only after that hub's own leader-timeout grace (measured from a block-driven round-ready time, so every honest hub applies the same window) — preventing an early or malicious fallback from usurping a still-alive leader and injecting prices. The fallback proposer is still validated strictly against each receiver's locally-observed submission map, never a peer-supplied list, preserving the price-integrity gate. The grace bookkeeping (`roundReadyAt`, `leaderTimers`) is pruned on finalize/skip/error and on `stop()`, with a TTL eviction bounding rounds that never finalize. No wire-format or schema change. Regression coverage added in `test/unit/OracleConsensus.test.js`: the elected fallback proposes after the grace when the leader submitted but never proposed; a non-elected follower arms no timer; the takeover aborts if a PROPOSE arrives during the grace; a receiver rejects a leader-timeout fallback before the grace and accepts it after; and after the grace only the lowest non-leader submitter is accepted.
- `src/ReorgHandler.js` — a reorg consensus round that times out without reaching quorum now emits a `reorg:timeout` event carrying the discarded rollback details before deleting the pending entry, instead of silently dropping it with only a `console.warn`. When a reorg is reported, the hub runs PBFT consensus and, on commit quorum, executes the rollback (deleting attestations and marking affected `price_snapshots` as `disputed`). If quorum is never reached within the window, the pending round was previously discarded with no programmatic signal — leaving cross-chain state dirty after a reorg (attestations un-deleted, snapshots un-disputed) with nothing for operators or downstream consumers to detect or retry against. Both timeout paths (`_initiateReorgConsensus` and the `_handlePrepare` follower-created round) now emit `reorg:timeout` with `{ reorgId, sourceChain, reorgHeight, timestamp, affectedChains, prepares, commits, quorum }` before the delete. This is purely additive — the discard behavior is unchanged, only now observable. Regression coverage added in `test/unit/ReorgHandler.test.js`: the event fires (with the rollback details) instead of silently discarding when quorum is not reached, on both the initiator and follower-created round paths.
- `src/ReorgHandler.js` — the reorg consensus quorum is now locked into the pending round at round start instead of being recomputed live on every quorum check, matching the round-lock pattern already used by `Consensus`, `OracleConsensus`, `CrossChainEngine`, and `AttestationConsensus`. Previously `_checkPrepareQuorum` and `_checkCommitQuorum` each called `_getQuorum()` at the instant they ran, while the pending object carried no quorum field — so the threshold could shift between PREPARE and COMMIT within a single 60s round whenever the effective N changed (hubs holding different `validatorSet` snapshots, or, when `validatorSet` is empty, the fallback live peer-connection count returning different values on separate calls). That let some hubs reach COMMIT quorum at the old N while others did not, risking split-brain reorg behavior — a partial cross-chain rollback on a subset of the federation. `_initiateReorgConsensus` and the `_handlePrepare` fallback path now stamp `quorum: this._getQuorum()` into the pending object, and both check methods read `(typeof pending.quorum === 'number') ? pending.quorum : this._getQuorum()`, so every node freezes the same threshold for the full duration of the round. The live-recompute fallback is preserved for any pending object that predates the field. No wire-format or schema change.
- `src/CrossChainEngine.js`, `src/XChainHub.js` — cross-chain attestation quorum is now locked to a deterministic block-boundary snapshot of the `cross_chain` capability set instead of the live in-memory validator set, matching the block-boundary determinism already used by `Consensus` and `OracleConsensus`. Previously `_getQuorum()` read `this.validatorSet` at the instant it was called — proposal creation on the leader, PROPOSE receipt on each follower — so two hubs processing the same `XCHAIN_ATTEST_PROPOSE` at slightly different wall-clock times could compute different quorum thresholds if a validator's capability qualification flipped (e.g. a self-test toggling `qualified`) in the interim, risking a split-quorum round where some hubs finalize an attestation and others stall. The leader now resolves the current BTC block height and stamps it into the PROPOSE envelope as `btcBlockHeight`; both the leader and every follower derive the round's quorum from `capabilitySnapshot.getSnapshot('cross_chain', btcBlockHeight)` via the new `_resolveQuorum()` helper, so all hubs lock the same N for the round regardless of when they process the message. The lookup falls back to the live validator set when the indexer is unreachable or the envelope carries no block height (an old peer mid rolling deploy), preserving prior behavior under degradation. `_handlePropose` becomes async for the snapshot lookup, with errors caught at the gossip dispatch boundary (mirroring `OracleConsensus`). Separately, `XChainHub.syncValidators()` refreshed the validator sets of `consensus` and `oracleConsensus` but not `crossChain`, so the cross-chain engine kept running with a stale live set (used for leader selection and the snapshot-unavailable fallback) after a mid-session validator sync; it now also reloads `crossChain`'s validator set and chain-pair subsets. Regression and unit coverage in `test/unit/CrossChainEngine.test.js`, `test/unit/security.test.js`, and `test/regression/crosschain.regression.test.js` updated for the now-async PROPOSE handler.
- `src/OracleConsensus.js` — `_aggregate()` now counts at most one price value per sender per coin pair. The trimmed-median aggregation iterated every entry in a sender's submission and pushed a value for each one matching the target pair, so a submission containing N entries for the same pair contributed N data points. This inflated `values.length` and therefore the trim boundary (`Math.floor(values.length * 0.15)`), shifting how many extremes are discarded and letting a duplicated outlier price survive the trim and bias the consensus median. The per-sender gate elsewhere blocks a *second* submission message from a sender but does not deduplicate pairs *within* an accepted submission, so a validator crafting its own gossip payload could exploit this even though the honest price fetcher always emits exactly one entry per pair. The inner loop now `break`s after collecting the first valid value for the pair from a given sender (invalid leading entries — zero/negative/NaN/out-of-range — are still skipped so a later valid entry is used). The change is a no-op for honest single-entry submissions. Regression coverage added in `test/unit/OracleConsensus.test.js`: N duplicate entries from one sender count as a single data point (a duplicated outlier is trimmed rather than dominating the median), and an invalid leading duplicate is skipped in favor of the sender's first valid entry.
- `src/AttestationConsensus.js` — an `ATTEST_COMMIT` that arrives in the window after a round's `pending` state exists but before its winner is established is now buffered and replayed instead of being silently dropped, restoring liveness in federations where the responsible-set quorum is greater than one. The transition from PROPOSE to a chosen winner runs through `provider.agree()`, which is asynchronous (it awaits the `llm` judge-model API for that strategy), so there is a real interval during which `pending` is set but `pending.winner` is still `null`. The early-arrival buffer (`earlyMessages`) drains in push/arrival order in `propose()`, so when a fast peer's COMMIT is buffered ahead of its own PROPOSE, the drain replays the COMMIT first — at which point `pending` exists but no winner has been picked — and `_handleCommit` hit `if(!pending.winner) return;` and discarded the vote permanently, with no re-queue path. In `N=3`/quorum=1 federations the node's own COMMIT still sufficed to finalize so the drop was masked, but in any larger federation with quorum > 1 a lost early COMMIT forced the round to wait for another peer's COMMIT or for the 120s round timer — stalling `ATTEST v1` (response) publication and the downstream contract callback until a re-broadcast arrived or the request expired as a system-synthesized `ATTEST v2`. This was a liveness fault only: no node could ever commit an inconsistent value, because the buffered COMMIT is still validated against the winner once replayed. `_handleCommit` now routes the `!pending.winner` case into a new per-request `earlyCommits` buffer (mirroring the existing `!pending` → `earlyMessages` path, bounded by `earlyCommitMaxPerRid`) rather than returning, and the two sites that establish `pending.winner` — `_maybeAdvanceFromProposals` (after `provider.agree()` resolves) and `_handlePrepare` (when a follower adopts the leader's body) — drain that buffer via `_drainEarlyCommits`, which deletes the queue up-front so the re-entrant `_handleCommit` calls (now with a winner) process the votes normally instead of re-buffering. The buffer is cleaned up on round finalize, on round timeout, and on `stop()`. Regression coverage added in `test/unit/AttestationConsensus.test.js` (the first unit coverage for `_handleCommit`): a COMMIT arriving before the winner is buffered rather than dropped, the buffered vote is counted once the winner is set and the queue drained, the per-request buffer is capped, a COMMIT arriving after the winner is applied directly without buffering, and a COMMIT arriving before the round exists still falls through to the unchanged `earlyMessages` path.
- `src/AttestationConsensus.js` — the attestation PBFT handlers now reject an oversized peer-supplied `body_b64` before allocating a Buffer, instead of decoding any base64 payload that fits the WebSocket frame. `_handlePropose` and `_handlePrepare` each decoded `body_b64` directly via `Buffer.from(String(d.body_b64 || ''), 'base64')` with no application-level length check, so the only size gate on an incoming PROPOSE/PREPARE was the ~1 MB WebSocket frame limit — 22–46× larger than any legitimate provider response (`http_get` default `max_response_bytes` 32 KB, `llm` 16 KB). A validator in the round's responsible set could therefore send near-frame-sized messages and, at the existing per-peer message rate, force sustained multi-hundred-KB Buffer allocations per message — a memory-amplification denial-of-service vector against a hub from a single compromised or malicious federation node. Both handlers now compute the maximum allowed base64 length from the round provider's configured `max_response_bytes` (× 1.4 base64 expansion) via the new `_maxBodyB64Length(providerId)` helper and return early with a warning when `String(d.body_b64).length` exceeds it, before the `Buffer.from` decode and before signature verification; the helper falls back to a 64 KB cap when the provider definition or its `max_response_bytes` is unavailable. Legitimately-sized payloads are unaffected. Regression coverage added in `test/regression/attestation-body-cap.regression.test.js`: an oversized PROPOSE/PREPARE body is rejected before signature verification runs, a body at the cap still reaches verification, and the helper derives the cap from `max_response_bytes` and applies the fallback when the def is missing.
- `src/PriceAggregator.js` — `receiveOraclePrice` now scopes the effective-at lock-window check to `source_chain`, matching the dedup check immediately above it. The 24-hour front-running delay applied to PRICE v1 oracle *updates* keys on "has this oracle published this coin/tick/fiat before?", but the `prior` SELECT omitted `source_chain` while the dedup SELECT included it. An oracle whose address already had a row on one chain (e.g. BTC) therefore had its *first-ever* submission on a second chain (LTC/DOGE) for the same coin/tick/fiat misclassified as an update, stamping `effective_at = block_time + 86400` even though no row had ever existed on that chain — silently blacking out effective oracle pricing for FIAT dispensers on the new chain for 24 hours, and producing chain- and insertion-order-dependent behavior that was hard to debug. The corrupted `effective_at` also propagated to every indexer's hub-DB mirror via the sync broadcast. The `prior` query now binds `source_chain` (the same value persisted by the INSERT and matched by the dedup check), so a genuine same-chain update is still delayed 24h while a first cross-chain submission is effective immediately. No funds were ever at risk and the delay expired naturally; the fix removes the spurious blackout and the cross-chain behavioral asymmetry. Regression coverage added in `test/unit/PriceAggregator.test.js`: a BTC-then-LTC first-submission is effective immediately, a genuine same-chain LTC update is still delayed 24h, and the lock-window SELECT is asserted to bind `source_chain`.
- `src/PriceAggregator.js` — `receiveValidatedRound` no longer mislabels PRICE v0 snapshot provenance. The `price_snapshots` INSERT pinned `reference_chain` to the literal `'BTC'` regardless of the chain that actually carried the round, so every LTC- or DOGE-originated round was stored — and mirrored to indexer replicas via the hub DB-sync broadcast plus served by the explorer API — with `reference_chain = 'BTC'`, making the column unusable for any provenance/audit query scoped by originating chain. The defect was confined to this audit/attribution column: price values, consensus, fee calculation, and rollback all key on `reference_block`/`coin_pair`, so no price or ledger data was affected. The INSERT now binds the originating chain (`sourceChain`) into `reference_chain` via a placeholder, and the in-memory row echoed to the WebSocket broadcast is corrected to match. Separately, the `source_chain` fallback changed from `|| 'DOGE'` to `|| null`: a caller that omitted the chain previously had its rows silently labelled DOGE, masking a programming error; the inbound API handler already validates `source_chain`, so a missing value now trips the column's `NOT NULL` constraint and fails loudly instead of corrupting attribution. A one-off correction for existing rows ships in `migrations/2026-06-02-backfill-price-snapshot-reference-chain.sql`, which restores `reference_chain` from `source_chain` for historical LTC/DOGE rows (operator-run, with a preview query and a documented caveat that rows written via the old DOGE fallback are indistinguishable from genuine DOGE rows).
- `src/OracleRound.js`, `src/api.js` — oracle freshness state now survives a hub restart and is exposed to monitoring probes. Previously `OracleRound` initialised `consecutiveSkippedRounds` to `0` and `lastSuccessfulRoundTime` to `null` in its constructor and never rehydrated them, so after any restart (planned or crash-recovery) the hub presented a clean-slate appearance even when several rounds had been missed before it went down — and `/health` gated solely on DB reachability (`dbOk && dbCircuit !== 'open'`), so a probe polling it during a price-feed outage saw `healthy` the whole time. In a price-sensitive cross-chain context that false-healthy window could mask a stale feed indefinitely. `start()` now rehydrates both counters from the durable `price_snapshots` record before the round timer begins: `lastSuccessfulRoundTime` from the most recent `status='finalized'` row's `created_at` (converted to epoch ms to match the live value), and `consecutiveSkippedRounds` from the count of distinct rounds recorded after that finalized round that did not finalize. The rehydrate is best-effort — a query failure logs a warning and leaves the constructor defaults in place rather than blocking startup, and `price_snapshots` is durable so no price data is ever recomputed. The `/health` JSON-RPC handler now also derives oracle staleness on oracle-running (P2P-enabled) hubs: it reports `oracle_last_finalized_age_s` (server-computed age of the newest finalized round), `oracle_stale`, and `oracle_staleness_threshold_s`, and marks the hub `degraded` (HTTP 503) when that age exceeds the threshold — default `2 ×` the oracle round interval, overridable via `ORACLE_STALENESS_THRESHOLD_S` for slow-start environments. A node that has never finalized a round (age unknown) is treated as not-stale so a slow first round does not 503, and config-only hubs (no P2P) skip the check entirely. Monitoring can now detect a stalled feed straight from `/health` without invoking the heavier diagnostics RPC. Regression coverage in `test/unit/OracleRound.test.js`: a fresh `OracleRound` started against a DB with pre-existing skipped rounds rehydrates a non-zero skip streak and a non-null last-success time, a DB with no finalized round leaves last-success null while still counting the skip streak, and a failing hydration query leaves the clean-slate defaults without throwing.
- `src/AttestationPublisher.js`, `src/OraclePublisher.js` — the default-broadcast path now passes `encoding: 'P2SH'` (uppercase) to the encoder's `createTx`. The encoder validates the `encoding` field with a case-sensitive `Set.has()` lookup against an all-uppercase allowlist (`OP_RETURN`, `P2SH`, `MULTISIGN`, `P2WSH`), so the previous lowercase `'p2sh'` was rejected with JSON-RPC `-32602` (`Invalid encoding: "p2sh"`) before any PSBT was built. `EncoderClient._call()` surfaced that as a thrown error which the publisher's broadcast handler caught and logged, so every default `ATTEST v1` and `PRICE v0` broadcast silently produced no on-chain transaction in any deployment that configures `BTC_ENCODER_URL` / `DOGE_ENCODER_URL` without a custom `broadcastFn`. Uppercasing both call sites restores on-chain output and keeps the encoder contract explicit (no normalization shim required). The unit assertions in `test/unit/PublisherDefaultBroadcast.test.js`, which previously asserted the broken lowercase value and so gave false confidence, are corrected to expect `'P2SH'`.
- `src/OracleConsensus.js` — the fallback-proposer legitimacy check in `_handlePropose` now elects the fallback strictly from each receiver's locally-observed submission map, instead of the `submissionKeys` list piggybacked on the incoming `ORACLE_PROPOSE`. The deterministic round leader sometimes has no submission (its price fetch failed), in which case the lowest-address submitter takes over as fallback proposer; receivers decide whether an incoming PROPOSE is a legitimate fallback by recomputing that lowest-address submitter. Previously that computation trusted the proposer's own claimed `submissionKeys` whenever it was non-empty, falling back to the local map only for older peers that omitted the field. Because `submissionKeys` is attacker-controlled, a single registered (Byzantine) validator could send a PROPOSE carrying `submissionKeys = [its own address]` — a single-element set whose lexicographically lowest entry is itself — so that `leaderSubmitted` evaluated false and `keys.sort()[0] === envelope.sender` set `isFallback = true`, even when the real leader had submitted a valid price. The attacker's arbitrary prices were then accepted as the finalized oracle result and written to `price_snapshots`, from which they propagated to fee quotes in the hub and `xchain-indexer`, were served publicly by `xchain-explorer`, and were broadcast as `PRICE v0` transactions to the DOGE chain by the oracle publisher — making the manipulation irreversible on-chain; the injected price also became the deviation reference for slash detection, risking false slashes against honest validators whose real submissions differed. The handler now derives the candidate set solely from `[...submissions.keys()]` (the submissions this node has actually observed), so a peer-supplied set can no longer elect the proposer. The proposer still attaches its sorted `submissionKeys` to outgoing PROPOSE as a diagnostic/wire-compat hint, but receivers no longer trust it for the legitimacy check, and the field is dropped from the receive-side destructure to make that explicit. The accepted cost is a liveness edge case: because gossip delivery is async, a receiver whose local view lags the proposer's at the instant of election may reject a legitimate fallback and stall the round until the finalization timeout re-elects — a deliberate safety-over-liveness trade-off for a price-oracle integrity gate. Regression coverage in `test/unit/OracleConsensus.test.js`: a crafted PROPOSE whose `submissionKeys` claims the sender is the lone (lowest) submitter is rejected when the local map shows a lower submitter; a PROPOSE from the genuine lowest local submitter is still accepted and broadcasts `ORACLE_PREPARE`; and election uses the local map whether or not `submissionKeys` is present.
- `src/AttestationPublisher.js` — `onRequestFinalized` now rejects an oversized `ATTEST v1` (response) wire payload before it reaches the durable write-ahead log, instead of letting it poison the failover sweep indefinitely. The assembled wire string base64-encodes the attestation response body (expanding it ~33%) and appends the pipe-delimited fixed fields plus one block per committed signature, so a large provider response — e.g. a 5 KB `http_get` JSON body becomes ~6.8 KB of base64 — can push the total past the encoder's `MAX_DATA_BYTES = 8192` ceiling (`xchain-encoder/src/validator.js`). Previously the payload was enqueued to `attestation-queue.jsonl` first and only failed when the encoder's `createTx` threw a `RangeError`; that exception was caught and logged but the entry was already on the WAL, so every subsequent crash-replay and interval sweep re-built and re-submitted the same too-large payload, failing identically forever — the on-chain response was never written and the contract callback never fired (the request instead sat pending until its deadline and was synthesized into an `ATTEST v2` expire). The method now computes `Buffer.byteLength(payload, 'utf8')` immediately after building the wire string and, when it exceeds the new module-level `ATTEST_WIRE_MAX_BYTES` constant (`8192`, kept equal to the encoder's `MAX_DATA_BYTES`), logs a descriptive error naming the request ID, the actual size, and the limit, then returns early — so the oversized payload never enters the WAL and the failure is loud at the point of origin rather than buried in repeating sweep logs. The happy path for normally-sized responses is unchanged. Recovery still requires shrinking the provider's response body; no automatic truncation is attempted, since a truncated body would change the bytes the federation reached byte-equality consensus over.
- `src/AttestationConsensus.js` — attestation PBFT now computes its quorum over the REDUNDANCY-sized responsible set instead of the full attestation-validator count, restoring liveness in any federation larger than a single request's REDUNDANCY. Previously `propose()` derived the round quorum from `CapabilitySnapshot.getQuorum(snapshot)`, i.e. `2*floor((N-1)/3)+1` over `N` = the total number of attestation-capable validators in the federation. But the PROPOSE/PREPARE/COMMIT phases only exchange messages within the responsible set (`roundState.responsible`, length = REDUNDANCY): every handler gates incoming votes on `pending.responsible.some(v => v.pubkey === sender)`, so `pending.prepares.size` and `pending.commits.size` are hard-bounded by REDUNDANCY. Whenever `N > REDUNDANCY`, `_checkPrepareQuorum`/`_checkCommitQuorum` computed `needed = max(quorum, REDUNDANCY) = quorum` over `N`, a threshold the bounded vote sets could never reach — so every attestation round stalled until the 120s round timer fired and the request expired (system-synthesized `ATTEST v2`). Example: `N=10, REDUNDANCY=3` → quorum `7`, needed `7`, max prepares `3` → permanent deadlock. The bug was masked in development by single-node (`N=1`) and `N==REDUNDANCY` federations, but would have failed every real multi-hub deployment where more validators stake the `attestation` capability than a given request's REDUNDANCY. `propose()` now computes `quorum = responsible.length <= 1 ? 0 : 2*floor((responsible.length-1)/3)+1`; because `_checkPrepareQuorum`/`_checkCommitQuorum` read `pending.quorum`, both phases are corrected by the single assignment. `needed = max(quorum, REDUNDANCY)` now always equals REDUNDANCY for the supported tiers (R=3→needed 3, R=4→4, R=7→7) — i.e. all responsible validators must vote, which is reachable, with `f` Byzantine tolerance for the larger tiers. `CapabilitySnapshot.getQuorum()` is unchanged and still serves the federation-wide config-change (`Consensus`) and oracle (`OracleConsensus`) PBFT paths; its docstring and the `AttestationConsensus` module header now state that attestation PBFT derives its own quorum over the responsible set. The previous `capabilitySnapshot`-absent fallback (which used `snapshot.validators.length` as an ad-hoc quorum) is replaced by the same responsible-set formula.
- `src/Consensus.js` — `_handleNewView` now authenticates `PBFT_NEW_VIEW` announcements before advancing the local view, closing a liveness attack in which a single registered validator could steer leader election. Previously the handler set `this.view` to whatever view number any authenticated peer announced, with no check that the sender was the designated leader for that view or that the view even moved forward. Because leader rotation is `(seq + view) % N`, a single Byzantine (or buggy) validator could broadcast escalating `NEW_VIEW` messages to drive every follower to an arbitrary high view and pin subsequent leader election onto a node of its choosing — itself or a crashed peer — freezing all hub consensus (config writes, governance proposals, capability-staking changes, cross-chain attestation rounds) for as long as it kept transmitting, with `xchain-indexer`/`xchain-explorer` degrading as their hub config oracle went stale. The handler now (1) requires the claimed `seq` and `view` to both be numbers, (2) accepts only a strictly forward view move so a `NEW_VIEW` can no longer rewind the view to a lower number the announcer controls, and (3) verifies the sender is the rotation-designated leader for the *claimed* `(seq, view)` — `validatorSet[(seq + view) % N]`, the same rotation `_getLeader` uses but evaluated at the claimed view — mirroring the leader-identity check `OracleConsensus` already applies to its PROPOSE handler; with no validator set there is no leader to validate against and the announcement is rejected. The 2f+1 `VIEW_CHANGE` quorum that authorizes a transition remains enforced on the broadcasting side (`_handleViewChange` emits `NEW_VIEW` only after collecting quorum); `NEW_VIEW` envelopes carry no vote proofs, and a lagging follower that missed the `VIEW_CHANGE` round still relies on the leader's announcement to catch up, so the quorum is intentionally not re-verified at the receiver. No other PBFT phase logic changed. Regression coverage added in `test/unit/Consensus.test.js`: a `NEW_VIEW` from a non-leader peer does not advance the view, one from the designated leader does, and a `NEW_VIEW` cannot rewind the view to a lower number.
- `src/Consensus.js` — `_handlePrePrepare` no longer broadcasts a `PBFT_PREPARE` vote for a digest it can never commit. When a follower already holds a pending proposal for sequence `seq` (digest A) and a second `PRE_PREPARE` arrives for the same `seq` carrying a different but internally-valid config (digest B) — as can happen during a view transition where two leaders both propose for the same `seq` before the follower's proposal is cleaned up — the handler skipped re-creating the proposal (`pendingProposals.has(seq)` is already true), retrieved the existing proposal (still digest A), and then broadcast `PBFT_PREPARE` with the *incoming* digest B. Because both `_handlePrepare` and `_handleCommit` gate vote-counting on `proposal.digest` (A), that PREPARE was permanently orphaned: peers echoing it back were rejected and the vote could never reach quorum, stalling round progress until the follower's proposal-expiry timer cleared the stale entry. The handler now compares the existing `proposal.digest` to the incoming `configDigest` immediately after retrieving the proposal and returns early (with a warning log) when they differ, so no PREPARE is cast and no votes are added for a value the node cannot commit. No other PBFT phase logic changed. Regression coverage added in `test/unit/Consensus.test.js`: a second `PRE_PREPARE` for an already-pending `seq` with a conflicting digest leaves the existing proposal untouched and broadcasts no additional `PBFT_PREPARE`.
- `src/Consensus.js` — PBFT view-change acceptance now uses the round-locked quorum (the validator-set snapshot taken at proposal creation), matching `_checkPrepareQuorum` and `_checkCommitQuorum`, instead of recomputing quorum live from the current validator set. Previously `_handleViewChange` called `_getQuorum()` unconditionally, so if validators joined or unstaked between a proposal's creation and its leader timing out, the view-change threshold diverged from the threshold the rest of that round used. When the set grew, the election could become permanently unreachable (the round stalls until the finalization timer fires — a liveness failure); when the set shrank, the live quorum could drop low enough for too few votes — at the extreme a single node — to promote a new leader and broadcast `NEW_VIEW` (a safety violation). Followers still hold the in-flight proposal at view-change time (their follower-proposal lives for twice the leader timeout) and read `proposal.quorum`; the node that *initiates* the view change has had its proposal removed by the very timeout that triggers the change, so the locked quorum is now stashed in a new `viewChangeQuorums` map (keyed by seq, pruned of already-applied rounds) when `_initiateViewChange` fires and recovered there — falling back to the live `_getQuorum()` only when neither source is available, exactly as the prepare/commit checks do. No other PBFT phase logic changed. Regression coverage added in `test/unit/Consensus.test.js` exercising validator churn between proposal creation and view-change: a grown set still accepts on the locked (lower) quorum (liveness), a shrunk set holds at the locked (higher) quorum and does not promote (safety), and the initiating node recovers its locked quorum after its proposal is gone.
- `src/AttestationPublisher.js` — a finalized attestation response no longer depends on the leader surviving the moment between consensus finalization and the on-chain broadcast. Previously only the leader broadcast the `ATTEST v1` (response) tx on `request:finalized`, and `attestation-queue.jsonl` was write-only — `start()` created/truncated it but nothing ever read it back. A leader crash (or restart, or lost connectivity) in that window silently discarded the finalized result; the request then sat pending until its `deadline_block`, at which point the indexer synthesized an `ATTEST v2` (expire) and fired the callback with `status='expired'` — a worse outcome than if consensus had never run. The queue is now a durable, fsync'd write-ahead log written by **every** node in the request's responsible set (not just the leader) before any send attempt, and a sweep — run once on `start()` (crash replay) and then on an interval (`ATTESTATION_FAILOVER_POLL_MS`, default 30s) — re-broadcasts any entry whose request is still pending on the indexer. The leader's own entry is retried if the live broadcast failed or the process crashed (its surviving entry's timestamp is already past the `ATTESTATION_LEADER_RETRY_MS` grace, default 60s, so it replays immediately on restart while the happy-path live broadcast still wins under normal operation). A follower steps in once the leader has been silent for `ATTESTATION_FAILOVER_WINDOW_BLOCKS` blocks (default `2`), rank-staggered by the deterministic `SHA256(request_id ‖ pubkey)` responsible-set ordering — recomputed in-publisher from the `attestation` capability snapshot at the request's `block_index`, mirroring `AttestationRound` — so the set takes over in order rather than all at once, using the committed signatures already carried in the queued payload. The indexer's pending-request set is the authoritative double-broadcast guard: an entry whose request is no longer pending has already landed on-chain (or expired) and is dropped without re-broadcast, and when the indexer is unreachable the queue is retained untouched for a later sweep rather than risking a duplicate. Successful broadcasts drop their entry by re-reading and filtering the queue, so a finalize that fires mid-sweep is never clobbered. This closes the gap before Phase 3 gas escrow attaches a financial penalty to expired attestations. Regression coverage in `test/unit/AttestationPublisherReplay.test.js` (crash replay of a still-pending leader entry, drop-without-rebroadcast of an already-landed entry, follower step-in only after the silence window, leader live-broadcast drop-on-success, follower persist-without-broadcast, and indexer-unreachable deferral).
- `src/AttestationConsensus.js`, `src/AttestationRound.js` — bounded two attestation-subsystem in-memory structures that previously grew monotonically for the process lifetime. `AttestationConsensus.finalized` (the double-publish guard) accumulated one request ID per finalized attestation with no eviction path; it is now a ring buffer capped at the most-recent `ATTESTATION_FINALIZED_MAX` IDs (default `10000`), which is safe because a finalized request only needs duplicate suppression within its active round window — any ID old enough to be evicted has long since exited that window. `AttestationRound.rounds` (per-request round state) was populated on every evaluated request and only ever cleared on `stop()`; it now lazily evicts entries whose `proposedAt` is older than `ATTESTATION_ROUND_TTL_MS` (default 1 hour, comfortably beyond the ~2-minute round lifecycle) on each poll cycle, mirroring the existing `seen`-map TTL eviction. The failed-fetch round entry now also carries `proposedAt` so it is eligible for the same eviction. Both structures' read/guard semantics are unchanged; only their memory footprint is now bounded. At prior request volumes the growth was latent (small entries, cleared by any restart), pre-empted before attestation throughput scales.
- `src/PriceFetcher.js`, `src/OracleConsensus.js`, `src/OracleRound.js`, `src/constants.js` — unified the price upper-bound check under a single `PRICE_MAX` constant (`10_000_000`, exported from the new `src/constants.js`). Previously the ingestion layer accepted prices up to `1e12` (`PriceFetcher.js` CoinGecko and CoinMarketCap parsing) while both the aggregation layer (`OracleConsensus._aggregate()`) and the gossip-receive path (`OracleRound._handleMessage()`, via `this.priceMax`) discarded anything `>= 10000000`. A price in `[10M, 1e12)` therefore passed ingestion, was recorded in `oracle_submissions`, and was broadcast via gossip, only to be silently dropped during aggregation with no log warning — so `oracle_submissions` could diverge from the finalized `price_snapshots` for the same round. Ingestion now rejects at the same binding consensus ceiling, so a value the aggregator would discard is never accepted, recorded, or gossiped in the first place; the ceiling lives in exactly one place and can be raised there before adding any high-nominal-value fiat pair. Latent today (no BTC/LTC/DOGE fiat price approaches 10M), pre-empted before it can surface. Additionally, `OracleRound._handleMessage()` now persists the already-filtered `validPrices` list to `oracle_submissions` rather than the raw gossip payload, so the durable submission record matches the set actually used for in-memory aggregation. Existing oracle/price unit coverage (`test/unit/OracleConsensus.test.js`, `OracleRound.test.js`, `PriceFetcher.test.js`, `PriceAggregator.test.js`) passes unchanged.
- `src/OracleConsensus.js` — the single-node (`quorum === 0`) branch of `finalizeRound()` now calls `this.finalized.add(round)` after storing the snapshot, matching the multi-node PBFT path and `_storeSkippedRound()`. Previously this branch stored the snapshot and emitted `round:finalized` but never marked the round finalized, so the dedupe guard at the top of `finalizeRound()` was a no-op in single-node mode: a second call for the same round re-ran `_storeSnapshot()` and re-emitted `round:finalized`, which could enqueue a duplicate PRICE v0 broadcast (the publisher's enqueue path has no dedup of its own). Single-node mode is the primary regtest configuration. Regression coverage added in `test/unit/OracleConsensus.test.js` — the single-node test now calls `finalizeRound()` twice for the same round and asserts `_storeSnapshot` and the `round:finalized` event each fire exactly once.
- `src/providers/http_get.js` — the `byte_equality` attestation consensus (`agree()`) now requires a simple majority to declare a winner, replacing the BFT `2*floor((N-1)/3)+1` quorum formula. The BFT form degenerates to `quorum=1` at `N=3` (`f=0`), so under the supported `REDUNDANCY=3` configuration three validators returning three *different* bodies each formed a group of count=1 that cleared the quorum, and the first-inserted group won — making a single stale or adversarial validator's response canonical with no agreement at all. The replacement `ceil((N+1)/2)` yields `quorum=1` at N=1, `2` at N=3 (true 2-of-3), and `3` at N=5 (unchanged from the BFT result, so the already-safe `REDUNDANCY=5` tier is unaffected). This also fixes the spot-check path: `AttestationSpotChecker.onRequestFinalized` calls `agree()` with the published body and the expected pattern as two proposals (`N=2`), where the old `quorum=1` let a published/expected mismatch silently pass; the new quorum is `2`, so both must agree for the spot-check to pass. Operators who ran `REDUNDANCY=3` http_get attestations before this fix should be aware that on-chain attestation results from that period may have been decided by a single validator rather than a majority. Regression coverage added in `test/unit/http_get_provider.test.js` (all-distinct N=3 returns null; N=2 mismatch returns null).
- `src/Consensus.js` — the PBFT `pendingViewChanges` map (`Map<view, Set<sender>>`) is now pruned so it can no longer grow without bound, and is cleared on engine shutdown. Entries are added whenever a `PBFT_VIEW_CHANGE` message arrives for a view that has not yet accumulated a quorum of votes, but the only removal site was the successful-quorum path (`size >= quorum`), which deletes just the one view that cleared. A view-change round that never reaches quorum — e.g. a single peer timed out and voted while the rest of the federation stayed healthy — therefore left its Set in the map permanently; under a flapping network that repeatedly fails proposals at distinct view numbers, the map accumulated one stale entry per failed view, consuming unbounded in-process memory (the leak is purely in-memory — `pendingViewChanges` is never serialized, persisted, or read by any other service, so consensus correctness and fund safety were never at risk). On a successful view change, `_handleViewChange` now also deletes every entry whose view is strictly below the newly-adopted `this.view`; views are monotonic, so a view we have advanced past can never gather further votes. This mirrors the existing `viewChangeQuorums` prune in `_initiateViewChange`. Additionally, `stop()` now calls `pendingViewChanges.clear()` alongside the existing `pendingProposals`/`viewChangeQuorums` clears, so a within-process restart (e.g. a hub reconfiguration that tears down and re-initialises the consensus engine) does not inherit stale sub-quorum tallies from the previous run. In healthy operation the map stays empty (quorum always clears entries), so steady-state behaviour is unchanged; no wire-format or schema change.

### Changed
- `src/api.js`, `src/db.js`, `src/XChainHub.js` — `getallconfigs` now accepts an optional `since_updated_at` cursor (epoch seconds) and returns a `watermark` alongside `configs`/`seq`. When a caller echoes the previous response's `watermark` back as `since_updated_at`, the hub returns only the config rows whose `updated_at` is strictly newer — typically an empty delta on a quiet poll — instead of the full `configs` table on every refresh. This removes the unbounded full-table `SELECT` that each config consumer issued on every poll (explorer/SDK ~60s, sync ~5min, plus the hub's own staking poll), whose payload and query cost grew linearly with `(coin × network × module × param)` rows as chains are added. The cursor is anchored on `UNIX_TIMESTAMP(updated_at)` so the value is an integer that survives JSON round-trips and re-binds into the query without timezone ambiguity; `MAX(updated_at)` is read before the rows so a write racing the two reads is re-delivered on the next poll rather than skipped. Fully backward-compatible: a caller that omits `since_updated_at` receives the complete tree exactly as before. Adds `Database.getConfigWatermark()` and a thin `XChainHub.getConfigWatermark()` wrapper; `Database.getAllConfigs()` gains an optional `sinceUpdatedAt` argument (behaviour unchanged when omitted). Integration coverage in `test/integration/db/configCursor.integration.test.js`.
- `src/api.js`, `src/db.js`, `src/XChainHub.js` — the `getallconfigs` JSON-RPC method now returns `{ configs, seq }` instead of a bare config map, where `seq` is the last PBFT-committed consensus sequence number (`0` on a fresh node with no commits yet). The committed sequence (`consensus_state.last_seq`) previously never left the hub process, so a governance-committed config change (e.g. a gas-price or staking-parameter update) was invisible to a config consumer until that consumer's process restarted. Exposing `seq` lets a consumer compare it between polls and re-apply its cached config the moment a change is committed, with no restart. The config tree is preserved unchanged under the `configs` key, and consumers that predate the wrapper read the bare map and treat a missing `seq` as `0` (no change detected), so the change is backward-compatible during a rolling upgrade. Adds `Database.getLastSeq()` (returns `0` when no row exists or the stored value is unparseable) and a thin `XChainHub.getLastSeq()` wrapper.
- `package.json` — aligned the `mariadb` driver to the `^3.5.2` range used across the platform. The driver was previously pinned to `~3.4.5` (a patch-only range, one minor line behind the `xchain-dashboard` host); the caret range now tracks 3.x minor releases consistently with every other service, removing the version drift and the mix of `~`/`^` range operators across the platform. No source changes.
- `XChainHub._resolveBtcLatestBlock` now guards against anchoring consensus snapshots on a stale indexer tip. The indexer's `getlatestblock` response includes a `lag` field (blocks its committed tip trails the decoder's current tip); when that lag exceeds the new `MAX_INDEXER_LAG_BLOCKS` threshold (default `200`), the hub ignores the returned tip and returns `null`, falling through to its existing graceful-degradation path instead of locking a potentially stale validator set into the current PBFT round. A far-behind indexer (e.g. stalled by repeated contract watchdog timeouts) previously fed the hub a stale block height with no guard. Only the direct `getlatestblock` fallback path is affected; the primary chain-tip-push path is unchanged. Documented in `.env.example` and `CONFIGURATION.md`.
- Upgraded `express-rate-limit` from `^7.5.0` to `^8.5.2`, aligning it with the version used by the other platform API services so rate-limiter configuration can be shared safely across services. The limiter config in `src/api.js` now uses v8's canonical option names (`windowMs`, `limit`, `standardHeaders`, `legacyHeaders`) — the per-window request cap was renamed from the deprecated `max` alias to `limit` (`max` still works as a backward-compatible alias but is slated for removal in a future major), so runtime behavior is unchanged; the v8 breaking changes (`keyGenerator` signature, removal of `onLimitReached`, and the `handler` callback signature) do not affect any code here. The rate-limit chaos test (`test/chaos/api/rate-limit-saturation.chaos.test.js`) was updated to the `limit` option name and continues to pass under v8.
- Renamed the API rate-limit environment variable from `HUB_API_RATE_LIMIT` to `HUB_RATE_LIMIT_RPM` (default `100` requests/minute per client, unchanged), adopting the per-service `<SERVICE>_RATE_LIMIT_RPM` naming convention shared across the platform's API services. **Operators who set `HUB_API_RATE_LIMIT` must migrate to `HUB_RATE_LIMIT_RPM`** — the old name is no longer read.

### Added
- `.env.example` and `CONFIGURATION.md` — added a configuration template and a full reference documenting every environment variable the hub reads, grouped by concern (core API, database, telemetry, P2P cluster, oracle rounds, price feeds, consensus, attestation/oracle publishers, governance, LLM provider). Both prominently flag the two variables that fail silently when left empty — `HUB_API_KEY` (empty silently disables API authentication) and `SIGNING_PRIVKEY_HEX` (empty leaves P2P messages unsigned and the hub without a federation identity) — and explain how to generate strong values.
- `OracleRound.getSubmissionsInfo()` — new `chainTipStalenessMs` field on the `getoraclesubmissions` diagnostics response, reporting the server-computed age (in ms) of the last successful BTC chain-tip read (`null` until the first success). Complements the existing `btcBlockHeight`, `usingFallback`, `chainTipFetchFailures`, and `lastChainTipFetchAt` fields so a monitor can threshold chain-tip staleness directly rather than diffing the ISO `lastChainTipFetchAt` against its own (potentially skewed) clock. Purely additive.
- `src/api.js` — new `health` JSON-RPC method. Like `ping` it probes the database, but it additionally reports the DB circuit-breaker state (`dbCircuit`), so an operator can distinguish a healthy hub from one that is up but stalled waiting on a tripped database connection. Returns HTTP 503 when the database is unreachable or the breaker is open. Purely additive — `ping` is unchanged.

## [2.2.12] - 2026-05-29

### Fixed
- Capability-staking qualification now compares stake amounts exactly instead of through `parseFloat`, eliminating a latent precision defect that could mis-qualify a validator. `XChainHub._compareDecimal` previously coerced both decimal-string operands to float64, which carries only ~15–16 significant decimal digits; an aggregated stake from the indexer (`SUM(CAST(s.amount AS DECIMAL(30,8)))`) with 8+ significant integer digits and 8 decimal places exhausts the float64 mantissa, so two amounts differing only in their least-significant satoshi (e.g. `90071992.00000001` vs `90071992.00000002`) collapsed to the same float and compared equal. Because qualification uses `_compareDecimal(amount, minStake) >= 0`, an underweight validator could be marked `qualified`, and that activation is gossipped to federation peers who accept it without re-running the comparison. The method now compares the decimal strings digit-for-digit via `BigInt` (sign + integer/fraction parts, fraction zero-padded to a common scale), returning `-1`/`0`/`1` with `0` for any unparseable operand — exact at any magnitude, no new dependency.
- `Governance._validateChangeBounds` evaluates parameter bounds-change ratios exactly for the same reason. The increase/decrease checks previously computed `(proposed - current) / current` in float64; on large parameter values the subtraction could round before the comparison. The thresholds (whole-percent: 50/33% normal, 25/20% slashing) are now compared by exact `BigInt` cross-multiplication that preserves the original sign-sensitive behaviour for negative current values; the float ratio is retained only to render the percentage in the error message.

## [2.2.11] - 2026-05-29

### Fixed
- `AttestationRound` no longer starves newer attestation requests under a sustained backlog, and no longer leaks memory by remembering every request it has ever evaluated. The poller previously asked the indexer for the oldest 100 pending requests every cycle (`getpendingattestation_requests` with a fixed `limit: 100`, ordered `block_index ASC`); whenever 100+ requests were pending, any newer request was permanently invisible until the oldest 100 drained. The poller now sends a keyset cursor (`after_block_index` / `after_action_index`) and pages forward through the entire pending set across cycles, restarting the sweep from the oldest request once it reaches the tail (a short page). Separately, the `seen` set — which suppressed re-evaluation of already-processed requests — was a `Set` that grew for the whole process lifetime and never released requests skipped for transient reasons (provider not yet registered, empty capability snapshot), so those requests were silently dropped until a restart. It is now a timestamped `Map` whose entries are evicted after `ATTESTATION_RETRY_AFTER_MS` (default `5 × ATTESTATION_POLL_MS`), bounding memory and letting transiently-skipped requests retry once the blocking condition clears. Companion to the indexer change (≥ 2.7.10) that adds the optional cursor parameters to `getpendingattestation_requests`.

## [2.2.10] - 2026-05-29

### Changed
- Dependency installs are now reproducible: `package-lock.json` is committed to the repo (previously git-ignored) and the Docker image is built with `npm ci` instead of `npm install`. `npm ci` installs the exact dependency tree recorded in the lockfile and fails the build if the lockfile is missing or out of sync with `package.json`, so a container image can no longer silently pick up newer transitive dependency versions than were tested.

## [2.2.9] - 2026-05-29

### Security
- Hub→indexer federation read calls now attach the `x-api-key` header (sourced from `BTC_INDEXER_API_KEY`, the same env var `RewardTracker` already uses for reward pushes) so they authenticate against the indexer's API-key gate. A new `XChainHub._btcIndexerHeaders()` helper builds the header set; `XChainHub._pollOwnStake` (`getownstake`), `CapabilitySnapshot.getSnapshot` (`getcapabilityvalidators`), `CapabilitySnapshot.getActiveValidatorSnapshot` (`getactivevalidators`), and `AttestationRound._pollPending` (`getpendingattestation_requests`) all route through it. Companion to the indexer change that gates those four read methods; previously they were unauthenticated, exposing the staked validator set and the pending attestation work queue to any host with network access to the indexer port. When `BTC_INDEXER_API_KEY` is unset the header is omitted and behaviour is unchanged (single-host setups where the indexer runs no key). `getlatestblock` is intentionally left ungated — it returns only a block height and is not part of the protected set.

## [2.2.8] - 2026-05-29

### Fixed
- `CrossChainEngine` now locks the PBFT quorum threshold into each pending attestation when the round is created, instead of re-deriving it live on every prepare/commit check. Both `_checkPrepareQuorum` and `_checkCommitQuorum` previously called `_getQuorum()` against the current in-memory `validatorSet`, so if a hub's validator set changed mid-round (e.g. two hubs holding different sets at startup, or a set update arriving between phases), two hubs could compute different thresholds for the same attestation round — one would commit while the other waited forever, silently diverging the federation with no error surface. The quorum is now captured at attestation creation time on both the leader path (`requestAttestation`) and the follower path (`_handlePropose`, using the chain-pair-aware count from the PROPOSE), and both quorum checks read that locked value (falling back to a live recompute only if the field is absent, for backward compatibility with in-flight rounds). This brings `CrossChainEngine` in line with the round-start quorum locking already enforced by `Consensus` and `OracleConsensus`.

## [2.2.7] - 2026-05-29

### Fixed
- `CapabilitySnapshot` now sends the hub's own governance-sourced `MIN_STAKE` threshold (`CapabilityRegistry.getMinStake()`) as a `min_stake` field in the `getcapabilityvalidators` RPC, making the hub the authoritative source of the threshold for its federation snapshot queries. Previously the call carried only `{capability, block_index}`, so the BTC indexer applied the `MIN_STAKE` from its *own* local config file when building the `HAVING` filter. Two hubs pointing at independently-operated indexers whose configs had drifted (or one indexer updated mid-round) would receive different validator sets for the same block — different `N`, different PBFT quorum thresholds — silently breaking the cross-hub determinism the snapshot guarantees, manifesting as deadlock or false quorum with no error surface. The threshold now depends only on on-chain stake state plus this hub's governance view, not on indexer config. When the capability registry isn't ready yet (the snapshot exists before `startCapabilities()`), the field is omitted and the indexer falls back to its local config as before. Requires the companion indexer change that honours the supplied threshold; older indexers ignore the extra field and continue using local config.

## [2.2.6] - 2026-05-29

### Fixed
- Capability `MIN_STAKE` thresholds approved by governance now take effect across the federation without a hub restart. `CapabilityRegistry.capConfig` was seeded once from `p2pConfig.CAPABILITIES` at startup and never refreshed, so `getMinStake()` kept returning the startup value for the life of the process. A passed governance proposal that raised or lowered a capability's stake threshold therefore only applied to freshly-restarted nodes — long-running nodes kept the old threshold and computed a different qualified-validator set, splitting PBFT quorum membership (oracle, cross-chain, attestation) across the federation until every hub was restarted. `XChainHub.startAttestation()` now also listens for `proposal:finalized` and, for parameters named `CAPABILITY_<CAP>_MIN_STAKE` (e.g. `CAPABILITY_PRICE_MIN_STAKE`, `CAPABILITY_CROSS_CHAIN_MIN_STAKE`), applies the new value to the in-memory config via `CapabilityRegistry._applyGovernanceChange()` and re-evaluates this node's own qualification against the new threshold (using the most recent observed on-chain stake amount; the periodic stake poll reconciles on its next tick). Mirrors the existing `ProviderRegistry.hotReload()` wiring on the same event.

## [2.2.5] - 2026-05-29

### Fixed
- Oracle fallback-proposer election no longer diverges across hubs under uneven gossip delivery. When the deterministic round leader has no submission, the lowest-addr submitter takes over as fallback proposer. Previously both the proposer (`finalizeRound`) and every validator (`_handlePropose`) derived that proposer independently from their own in-memory submissions map — and because submissions propagate via gossip with variable latency, two hubs could have seen different subsets of submitters at election time and computed different fallback proposers. A validator that elected a different fallback than the actual proposer rejected the proposer's `ORACLE_PROPOSE` as "non-leader", stalling the round until the 120 s finalization timeout. The proposer now piggybacks the sorted submission keys it elected itself from (`submissionKeys`) on the `ORACLE_PROPOSE` message, and validators verify fallback legitimacy against that authoritative view rather than their own divergent local map. Backward-compatible: messages without `submissionKeys` (older peers) fall back to the prior local-map behavior, so rolling upgrades are safe.

## [2.2.4] - 2026-05-29

### Fixed
- The publisher default-broadcast pipelines (`AttestationPublisher` for ATTEST v1 responses, `OraclePublisher` for PRICE v0 publications) passed the raw hex public key as the encoder's `pubkey` field. The encoder's P2SH path runs `bitcoin.address.fromBase58Check()` on that field, which throws for a hex string — so every on-chain broadcast through the default pipeline crashed at runtime. Both publishers now pass their base58check address (`btcAddress` / `dogeAddress`). Added unit coverage that exercises `_defaultBroadcast` directly with a mock encoder, closing a gap where the e2e harness's custom broadcast hook bypassed this path entirely.

## [2.2.3] - 2026-05-28

### Fixed
- Governance proposal tallying is now performed by a single deterministic leader per proposal rather than independently on every hub. Because validator votes propagate via P2P gossip with variable latency, two hubs could previously tally the same expired proposal at different moments with different vote counts and reach contradictory `passed`/`failed` conclusions, leaving governance state split-brain across the federation. The leader is chosen deterministically from the active validator set (hash of the proposal id, same modular-index pattern as oracle consensus); followers accept the broadcast `GOV_RESULT` as authoritative. Standalone hubs with no validator set still tally locally.
- `_tallyProposal` now guards its status write with `AND status = 'voting'`, so a stale or duplicate result broadcast cannot overwrite an already-finalized proposal.
- Governance now emits `proposal:finalized` (previously `proposal:passed`) to match the attestation provider-registry hot-reload listener in `XChainHub`. The mismatch meant a passed proposal never triggered the runtime provider-config reload; the reload now fires as intended.

## [2.2.2] - 2026-05-28

### Fixed
- `getFeeQuote` now carries the full 17-entry gas schedule (previously 7). Fee quotes for `OWNERSHIP_ESCROW`, `VM_DEPLOY_PER_BYTE`, `VM_STATE_READ`/`VM_STATE_WRITE`/`VM_STATE_DELETE`, `VM_ORACLE_READ`, `VM_CROSSCHAIN_READ`, `VM_ATTEST_REQUEST`, `VM_EMISSION`, and `VM_COMPUTATION` now return a numeric fee instead of an `unknown action` error.

### Changed
- `getFeeQuote` sources the gas price from the config store (per-chain, `chain` module), falling back to the protocol default `0.00001` when no override is present or the store is unavailable, instead of a hardcoded constant.

## [2.2.1] - 2026-05-28

### Security
- Pin `qs` to `^6.15.2` via an `overrides` entry, remediating GHSA-q8mj-m7cp-5q26 (moderate DoS: `qs.stringify` throws a `TypeError` on null/undefined entries in comma-format arrays when `encodeValuesOnly` is set). The override forces the patched version across all transitive dependency paths.

## [2.2.0] - 2026-05-28

### Added
- New JSON-RPC method `pushpricereorg` (write — requires API key) — an indexer calls this after a block rollback to retract price rows seeded from rolled-back PRICE actions. Params: `{ source_chain, from_action_index }`. The hub previously only invalidated price snapshots on a separate PBFT reorg attestation (`ReorgHandler`), which never arrives for non-PBFT reorgs, leaving never-finalized prices in `price_snapshots` / `oracle_prices` indefinitely.
- `PriceAggregator.retractFromActionIndex(sourceChain, fromActionIndex)` — deletes `price_snapshots` rows (keyed by `source_action_index`) and `oracle_prices` rows (keyed by `action_index`) for the given chain at or above the supplied action index, and emits `row:deleted` events with the deletion filter. Returns per-table deleted-row counts.
- `HubDbBroadcaster.broadcastDeletion(event)` — forwards `row:deleted` retraction events (`{ table, source_chain, from_action_index }`) over the `/hub-db/subscribe` WebSocket channel so distributed indexers prune their local `price_snapshots` / `oracle_prices` copies, mirroring the existing `row:inserted` broadcast path.

### Changed
- `XChainHub` — wires `PriceAggregator`'s new `row:deleted` event to `HubDbBroadcaster.broadcastDeletion`, alongside the existing `row:inserted` → `broadcastRow` wiring.

## [2.1.0] - 2026-04-08

### Added
- `PriceAggregator.js` — receives validated PRICE v0/v1 actions from indexers across all chains, deduplicates by `round_number` (v0) or `(source_chain, action_index)` (v1), writes to unified `price_snapshots` and `oracle_prices` tables. EventEmitter — emits `row:inserted` for the hub DB sync channel. Applies 24-hour lock window for PRICE v1 (first broadcast immediate, subsequent delayed).
- `OraclePublisher.js` — Tier 3 oracle publisher for broadcasting finalized PRICE v0 transactions to the DOGE chain. Features: deterministic leader rotation (`round % active_tier3_count`, sorted by `signing_pubkey`), persistent JSONL queue with fsync, PRICE v0 wire format builder, DOGE balance monitoring with WARN/ERROR log thresholds. Subscribes to `OracleConsensus` `round:finalized` events and uses collected validator signatures from the PBFT prepare/commit phases.
- `EncoderClient.js` — minimal JSON-RPC client for talking to `xchain-encoder` (`get_utxos`, `create_tx`, `broadcast_tx`). Used by `OraclePublisher` for the default DOGE broadcast pipeline.
- `HubDbBroadcaster.js` — WebSocket subscriber registry that forwards `PriceAggregator` row events to connected indexer hub DB sync clients. Includes backpressure handling (drops connections exceeding `WS_BACKPRESSURE_LIMIT` buffered messages).
- `sql/oracle_prices.sql` — new table for cross-chain user TOKEN/FIAT oracle prices with `effective_at` column enforcing the 24-hour price lock window.
- `setChainTip()` / `getChainTip()` in `db.js` — stores the latest BTC/LTC/DOGE chain tip in the `configs` table, used by `OracleRound._executeRound()` to anchor oracle rounds to real BTC block heights (fixes the hardcoded `reference_block=0` bug).
- New JSON-RPC methods on hub API: `pushchaintip`, `pushpriceround`, `pushoracleprice` — write methods (require API key) for indexers to push chain state and validated PRICE actions to the hub.
- REST snapshot endpoints: `GET /hub-db/snapshot/price_snapshots` and `GET /hub-db/snapshot/oracle_prices` with `since_id` pagination for incremental bootstrap of indexers' local hub DB copies.
- WebSocket channel `/hub-db/subscribe` — streams `row:inserted` events for the hub's cross-chain price tables to subscribed indexers. Requires `Authorization: Bearer <HUB_API_KEY>`.
- Multi-validator signature aggregation in `OracleConsensus.js` — each validator signs the canonical PRICE v0 payload (`JSON.stringify({round, timestamp, sortedPairs})`) during PBFT prepare/commit phases. Signatures travel in PROPOSE/PREPARE/COMMIT messages and collect on `pending.signatures` Map. The `round:finalized` event now carries the collected signatures array so `OraclePublisher` can embed real validator sigs in the published PRICE v0 transaction.
- `_signPriceV0()`, `_buildPriceV0Payload()`, `_verifyAndStoreSig()` helpers in `OracleConsensus.js` — canonical payload construction matching the indexer's `ed25519.js` format.

### Changed
- `OracleConsensus.js` — `_storeSnapshot()` and `_storeSkippedRound()` now accept `btcBlockHeight` and `btcBlockTime` parameters, replacing the hardcoded `reference_block=0` and `block_timestamp=Date.now()` values. Cross-node determinism fix: two independent nodes processing the same BTC block height now produce identical oracle snapshots.
- `OracleConsensus.finalizeRound(round, btcBlockHeight, btcBlockTime)` — accepts and threads BTC chain tip values through PBFT pending rounds to storage and round:finalized events.
- `OracleRound.js` — `_executeRound()` reads BTC chain tip from `db.getChainTip('BTC')` at the start of each round and passes it through `_scheduleFinalization()` to `OracleConsensus.finalizeRound()`.
- `PriceFetcher.js` — rewritten to support 3 coins × 12 fiat currencies = **36 pairs per round**. CoinGecko and CoinMarketCap APIs are now called with `vs_currencies` / `convert` parameters for all 12 fiats in a single call. Supported fiats: USD, CAD, AUD, MXN, GBP, JPY, CNY, CHF, BRL, INR, EUR, KRW. New static method `PriceFetcher.getCoinPairs()`.
- `OracleConsensus._storeSkippedRound()` — now uses `PriceFetcher.getCoinPairs()` for dynamic pair list instead of hardcoded `['BTC/USD', 'LTC/USD', 'DOGE/USD']`.
- `sql/price_snapshots.sql` — added `source_chain VARCHAR(10)` column (defaults to `DOGE`) to track which chain carried the PRICE v0 transaction, plus `source_action_index BIGINT` for audit. New index on `source_chain`.
- `RewardTracker.js` — `distributeRewards()` now accepts a `btcBlockHeight` parameter and pushes reward records to the BTC indexer via the new `pushvalidatorrewards` JSON-RPC endpoint. Populates the previously-empty indexer `validator_rewards` table so `CLAIM_REWARDS` can find unclaimed rewards.
- `XChainHub.start()` — instantiates `PriceAggregator` and `HubDbBroadcaster` (both available in all modes). In validator mode, `startOracle()` also instantiates and starts `OraclePublisher`.
- Hub `api.js` — now uses an explicit `http.Server` with WebSocket upgrade handler attached (for the hub DB sync channel). New `WRITE_METHODS` entries for the three new push methods.

### Fixed
- `reference_block` hardcoded to `0` in `_storeSnapshot()` and `_storeSkippedRound()` — now uses the BTC chain tip at the time of round execution. Previously broke cross-node determinism for fee validation and VM oracle queries.
- `block_timestamp` in price snapshots — now uses the BTC block's `block_time` instead of wall-clock `Date.now()`.
- `round:finalized` event — now carries `btcBlockHeight`, `btcBlockTime`, and `signatures` fields for downstream consumers.
- `README.md` — updated version badge to 2.0.12, added tests badge (1,222 passing), coverage badge, test suite breakdown table, expanded scripts table with all test commands, added development dependencies section, added links to new DATABASE.md and OPERATIONS.md documentation

## [2.0.12] - 2026-04-06

### Added
- Comprehensive regression test suite (195 tests across 7 files) covering:
  - Consensus PBFT: quorum math, leader rotation, full PRE_PREPARE→PREPARE→COMMIT flow, view change, sequence persistence, replay prevention, single-node fallback, digest determinism
  - Oracle pipeline: PriceFetcher local median, trimmed median aggregation (15% trim), PBFT finalization, price validation, 8-decimal formatting, single-node fallback
  - Cross-chain engine: attestation PBFT flow, confirmation thresholds (BTC=3, LTC=3, DOGE=6), chain-pair validator filtering, attestation:finalized events
  - SwapTracker: auto-progress on attestation finalization, lifecycle management, null safety
  - ReorgHandler: PBFT reorg consensus, attestation rollback, price snapshot dispute marking, affected chain computation
  - Governance: proposal lifecycle, vote collection, 2/3+50% quorum tally, parameter change bounds (±50%/±33% normal, ±25%/±20% slashing), 14-day cooldown
  - P2P & ValidatorIdentity: Ed25519 sign/verify round-trip, envelope signatures, message deduplication, signature enforcement, identity seed validation
  - Database: circuit breaker open/half-open/closed, parameterized queries, SQL injection prevention, config CRUD hierarchy
  - Incentives: equal-split reward distribution, slash detection (price deviation >5%, repeated deviation 3+/24h, non-participation 30+ rounds)
- Three-tier test execution via Mocha `--grep`:
  - `test:regression:p0` — 78 critical tests (<1s) for every commit
  - `test:regression:p0p1` — 154 high-priority tests (3s) for PR gating
  - `test:regression` — full 195-test suite (3s) for nightly/pre-release
- Regression testing plan document at `reports/XCHAIN_HUB_REGRESSION_TESTING_PLAN.md`

## [2.0.11] - 2026-04-06

### Added
- Mutation testing infrastructure using StrykerJS
- `stryker.config.json` — full mutation config targeting all `src/**/*.js` (excludes SQL schemas)
- `stryker.config.phase1.json` — pilot config targeting `Consensus.js` and `OracleConsensus.js` only
- `npm run test:mutate` script for full mutation testing
- `npm run test:mutate:pilot` script for Phase 1 pilot runs
- `@stryker-mutator/core` and `@stryker-mutator/mocha-runner` devDependencies

## [2.0.10] - 2026-04-06

### Added
- Chaos engineering test suite (81 tests, 14 files) covering:
  - Database resilience: circuit breaker lifecycle, flapping connections, pool exhaustion
  - Oracle fault tolerance: single source failure, total blackout, malformed price data
  - Consensus disruption: network partition, leader crash, quorum loss
  - Compound failures: reorg during oracle round, validator churn during consensus
  - API abuse protection: rate limit saturation, concurrent burst handling
- Chaos test helpers: experiment runner, steady-state checker, metrics collector
- `test:chaos` npm script (`mocha --timeout 30000`)

## [2.0.9] - 2026-04-06

### Added
- Performance and load testing suite (6 test files, 3 helpers) covering:
  - API query saturation with concurrent blast and ramp-up tests
  - Oracle round execution timing and degradation under load
  - P2P WebSocket message flood, dedup cache, and rate limiting verification
  - MariaDB connection pool stress, mixed read/write concurrency, and saturation
  - 2-minute soak test with memory leak detection and p95 trend analysis
  - Dependency degradation scenarios (slow/failed APIs, recovery timing)
- `test:perf` npm script (`mocha --timeout 300000`)
- Reusable performance helpers: `Histogram`, `MemoryTracker`, `blast()`, `ramp()`, `seedAll()`

## [2.0.8] - 2026-04-06

### Added
- API key authentication for write methods via `HUB_API_KEY` env var
- Rate limiting on JSON-RPC endpoint via `express-rate-limit` (`HUB_API_RATE_LIMIT`, default 100/min)
- Configurable CORS origin restriction via `CORS_ORIGIN` env var
- Chain validation (BTC/LTC/DOGE only) on all chain-accepting endpoints
- Limit parameter validation (positive integer, max 1000) on list endpoints
- Per-IP connection limit on P2P WebSocket server (`P2P_MAX_CONNECTIONS_PER_IP`, default 3)
- Per-peer message rate limiting on P2P layer (`P2P_MSG_RATE_LIMIT`, default 100/min)
- Dedup cache size bound to prevent memory exhaustion (`P2P_DEDUP_CACHE_MAX`, default 100000)
- Peer address format validation before WebSocket connection
- Consensus sequence monotonicity check to reject replayed PRE_PREPARE messages
- Single-node mode warning when `MIN_VALIDATORS` > 1 but no peers connected
- Minimum submission count for oracle round finalization (`ORACLE_MIN_SUBMISSIONS`, default 1)
- Price sanity bounds (> 0, < 10M) on oracle submissions, aggregation, and external API responses
- Max submissions per oracle round (`ORACLE_MAX_SUBMISSIONS_PER_ROUND`, default 200)
- Cross-chain attestation ID format validation
- Reorg report parameter validation (chain, height, timestamp) and rate limiting (1 per chain per 60s)
- Governance voter authorization (must be active validator to vote)
- Governance parameter name length limit (255 chars) and rationale length limit (2000 chars)
- Reward participant pubkey validation (must be 64 hex chars)
- Slash proposal pubkey validation and in-memory deviation array bounds (max 1000)
- Database query timeout (`DB_QUERY_TIMEOUT`, default 30s)
- Config structure validation with value length limit (1024 chars) and type coercion
- Security test suite (72 tests) covering all hardening measures
- `express-rate-limit` production dependency

### Changed
- `REQUIRE_SIGNATURES` now defaults to `true` (was `false`) — P2P messages require Ed25519 signatures by default
- Object query arguments serialized via `JSON.stringify()` instead of `toString()` with warning log
- Null-safe traversal for CoinGecko and CoinMarketCap API response parsing
- Invalid JSON on P2P WebSocket now logged at warn level instead of silently discarded

## [2.0.7] - 2026-04-06

### Added
- Fuzz testing suite (88 properties across 7 test files) using fast-check for property-based testing
- Shared generator module with 17 composable fast-check arbitraries for prices, submissions, P2P envelopes, hex strings, configs, and governance parameters
- OracleConsensus fuzz tests: trimmed median aggregation invariants, NaN/Infinity filtering, quorum monotonicity, digest determinism
- PeerManager fuzz tests: structural robustness against arbitrary JSON, malformed envelope rejection, deduplication correctness, ID uniqueness
- PriceFetcher fuzz tests: median bounds and immutability, API response parsing robustness, output format validation
- Consensus PBFT fuzz tests: leader rotation, quorum bounds, digest properties, PrePrepare message validation
- Governance fuzz tests: change bound enforcement for normal and slashing parameters, tally quorum arithmetic
- Fee quote fuzz tests: gas arithmetic consistency, round-trip precision, unknown action handling
- ValidatorIdentity fuzz tests: constructor validation, sign/verify round-trip, mutation detection, cross-key rejection

### Fixed
- Infinity values leaking through oracle price aggregation — replaced `!isNaN(val)` with `isFinite(val)` in `_aggregate()` filter
- TypeError crash in PeerManager when receiving non-object JSON (null, number, string) — added type guard after JSON.parse
- Message ID collisions under high throughput — replaced `Math.random()` with `crypto.randomUUID()` in `_makeId()`
- Object.prototype pollution in fee quote gas schedule lookup — replaced bracket notation with `hasOwnProperty` check

## [2.0.6] - 2026-04-06

### Added
- Boundary test suite (266 tests across 14 files) validating behavior at extreme input edges
- Quorum calculation boundary tests: N=0–100 across Consensus, OracleConsensus, CrossChainEngine, ReorgHandler
- Trimmed median aggregation boundary tests: trim threshold transitions (N=1–20), outlier handling, float precision, invalid data filtering
- PriceFetcher boundary tests: zero/negative/NaN/huge API responses, partial responses, dual-source failures
- Governance boundary tests: exact change bounds (50%/33%/25%/20%), tally quorum arithmetic, cooldown expiry
- SlashDetector boundary tests: exact 5% deviation threshold, missed rounds at 29/30/31, 24h repeated deviation window pruning
- Consensus PBFT boundary tests: leader rotation wrap-around, seq/view boundaries, PRE_PREPARE validation, duplicate vote dedup
- CrossChainEngine boundary tests: chain pair fallback with both orderings, confirmation thresholds per chain, attestation re-finalization
- ReorgHandler boundary tests: height 0, far-future timestamps, duplicate reorgId dedup
- RewardTracker boundary tests: division precision at N=1/3/7/100/1000, satoshi-level rounding loss
- Config management boundary tests: empty coin key filtering, PARAMETER_LIST enforcement, null/undefined/empty value handling
- Fee quote boundary tests: gas calculation precision, zero/small/large oracle prices, missing oracle data
- Validator registration boundary tests: pubkey regex edge cases (63/64/65 chars, non-hex), addr validation
- Database layer boundary tests: DB name regex, circuit breaker state transitions, doQuery argument handling
- P2P layer boundary tests: malformed envelope rejection, self-connection detection, dedup, signature verification modes

## [2.0.5] - 2026-04-06

### Added
- End-to-end test suite (64 tests across 8 files) validating full operational pipelines
- E2E test helpers: cluster manager (multi-hub in-process with real P2P), JSON-RPC client, price API mocks, async polling, DB assertion utilities
- Oracle E2E tests: price fetch → single-node finalization → JSON-RPC serving, API degradation, round skipping, reward distribution, multi-round persistence
- Config E2E tests: write/read round-trip, multi-coin updates, overwrite behavior
- Attestation E2E tests: single-node attestation lifecycle, SWAP initiation and status queries
- Governance E2E tests: proposal creation, vote casting, tally/pass, rejection with cooldown, change bounds enforcement
- Reorg E2E tests: rollback cascade (attestation deletion, reorg history), chain isolation
- Fee quote E2E tests: oracle-fed fee calculation, gas schedule verification, missing data handling
- API contract E2E tests: all 24 JSON-RPC methods validated, invalid input handling across all endpoints
- Multi-node E2E tests: 3-node cluster with real WebSocket P2P, PBFT oracle consensus, cross-chain attestation, cross-instance data consistency
- `npm run test:e2e` script

## [2.0.4] - 2026-04-06

### Added
- Smoke test suite (24 tests) for quick service health checks
- Covers env validation, DB schema init, JSON-RPC routing, config round-trip, PriceFetcher with mocked APIs, median calculation, oracle trimmed-median aggregation, circuit breaker state, and graceful handling of disabled subsystems
- `npm run test:smoke` script with `--bail` flag for fast-fail execution

## [2.0.3] - 2026-04-06

### Added
- Integration test suite (63 tests across 10 files) covering cross-module data flows
- Test infrastructure: testDb (real MariaDB setup/teardown), mockExternalApi (nock-based API mocking), testPeerNetwork (WS peer simulation, envelope builder)
- Oracle pipeline integration tests: price fetching, round lifecycle, persistence precision, reward distribution, slash detection
- Cross-chain integration tests: attestation PBFT, SWAP auto-progression, reorg rollback cascading writes
- Consensus integration tests: PBFT config consensus, single-node fallback, timeout/view-change
- Governance integration tests: proposal lifecycle, rejection, change bounds, cooldown, non-validator rejection
- JSON-RPC API integration tests: end-to-end Express server with config, validator, price, and fee quote endpoints
- P2P integration tests: real WebSocket message routing, deduplication, Ed25519 signature verification
- Resilience integration tests: circuit breaker activation/recovery, DB failure during finalization, concurrent operations
- `nock` devDependency for HTTP request interception
- `npm run test:integration` and `npm run test:all` scripts

## [2.0.2] - 2026-04-06

### Added
- Comprehensive unit test suite (295 tests) covering all 13 source modules
- Test infrastructure: mocha, chai, sinon, proxyquire devDependencies
- Shared test helpers: mockHub factory and fixtures (validator sets, sample prices)
- Tests for: ValidatorIdentity, OracleConsensus (trimmed median, PBFT), Consensus (PBFT, view change), SlashDetector (deviation/participation thresholds), CrossChainEngine (chain-pair filtering, attestation PBFT), PriceFetcher (API mocking), OracleRound, Governance (change bounds, tally logic), ReorgHandler (rollback, consensus), RewardTracker, SwapTracker, PeerManager (dedup, signatures), Database (circuit breaker), XChainHub orchestrator

### Changed
- `npm test` now runs mocha against `test/unit/**/*.test.js`

## [2.0.1] - 2026-04-06

### Changed
- Rewrite README.md to match xchain-sdk/xchain-indexer format: badges, feature bullets, documentation links, quick start, env vars, JSON-RPC API summary, database schema table, dependencies

## [2.0.0] - 2026-04-06

### Added
- Governance engine (`Governance.js`) — off-chain PBFT voting for parameter changes
- `governance_proposals` and `governance_votes` tables
- 7-day voting period with 2/3+ approval threshold and 50% quorum
- Proposal constraints: max 50%/33% change bounds (25%/20% for slashing params), 14-day cooldown after rejection
- `propose`, `vote`, `getproposals`, `getproposal` JSON-RPC methods
- Automatic proposal tallying when voting period ends
- `proposal:passed` event emitted for downstream parameter application
- HEARTBEAT messages now include hub software version for upgrade coordination
- `GOV_VOTING_PERIOD` env var (default 7 days)

### Changed
- **Major version bump to 2.0.0** — governance system completes the decentralized hub architecture (Phases 0-5)

## [1.9.0] - 2026-04-06

### Added
- SWAP lifecycle tracker (`SwapTracker.js`) — tracks cross-chain swaps through initiated → attested → executed → settled
- `swap_records` table for SWAP lifecycle persistence
- Per-chain-pair validator filtering in CrossChainEngine — only validators supporting both chains participate in cross-chain quorum
- `chains` and `tier` columns added to `validators` table (auto-migration on startup)
- Validators with NULL chains support all chain-pairs (backward compatible)
- `initiateswap`, `getswap`, `getswaps` JSON-RPC methods
- SwapTracker auto-progresses swap status on attestation finalization

## [1.8.0] - 2026-04-06

### Added
- Reorg handler (`ReorgHandler.js`) — cross-chain reorg propagation with PBFT consensus
- `reorg_attestations` table for storing confirmed reorg events
- Hub rollback on reorg: deletes attestations after reorg timestamp, invalidates price snapshots
- `REORG_ALERT` gossip message for reorg detection
- `XCHAIN_REORG_PREPARE` / `XCHAIN_REORG_COMMIT` for reorg consensus
- `reportreorg` JSON-RPC method — report a blockchain reorg for cross-chain propagation
- `getreorghistory` JSON-RPC method — query confirmed reorg attestations
- `reorg:confirmed` event emitted for downstream indexer notification

## [1.7.0] - 2026-04-06

### Added
- Cross-chain attestation engine (`CrossChainEngine.js`) — PBFT-based consensus for cross-chain action verification
- `attestations` table for storing finalized cross-chain attestations
- Attestation lifecycle: PROPOSE → PREPARE (2f+1) → COMMIT (2f+1) → store
- Per-chain confirmation thresholds (BTC: 3, LTC: 3, DOGE: 6)
- `requestattestation` JSON-RPC method — submit attestation requests
- `getattestations` JSON-RPC method — query stored attestations
- `getattestation` JSON-RPC method — get specific attestation by source chain + action index
- `attestation:finalized` event emitted for downstream processing
- Single-node fallback for attestations (stores directly without consensus)

## [1.6.0] - 2026-04-06

### Added
- Reward tracker (`RewardTracker.js`) — distributes XCHAIN rewards to oracle round participants
- Slash detector (`SlashDetector.js`) — detects price deviation (>5%), repeated deviation (3+ in 24h), and non-participation (30+ missed rounds)
- `validator_rewards` table for reward tracking with unclaimed/claimed status
- `slash_proposals` table for recording detected offenses
- `syncvalidators` JSON-RPC method — push validator set from external staking data
- `getvalidators` JSON-RPC method — list active validators
- `getvalidatorstatus` JSON-RPC method — detailed validator status with rewards and slash history
- `getfeequote` JSON-RPC method — calculates native coin fee amount via gas → XCHAIN → oracle conversion
- OracleConsensus now emits `round:finalized` event consumed by reward tracker and slash detector
- New env vars: `ORACLE_REWARD_PER_ROUND`, `SLASH_DEVIATION_THRESHOLD`, `SLASH_MISSED_ROUNDS_THRESHOLD`

## [1.5.0] - 2026-04-06

### Added
- Oracle consensus engine (`OracleConsensus.js`) — PBFT-like finalization for price rounds
- Trimmed median aggregation — discard top/bottom 15%, compute median of remaining submissions
- `price_snapshots` table for finalized price data (round_number, coin_pair, price, status, consensus_proof)
- Automatic round finalization after submission window closes
- Skipped round detection — rounds with no submissions stored as `status='skipped'`
- `getpricesnapshots` JSON-RPC method — returns recent finalized snapshots
- `getprice` JSON-RPC method — returns latest finalized price for a coin pair
- Single-node fallback — stores local prices directly as snapshots when no peers connected

## [1.4.0] - 2026-04-06

### Added
- Price oracle round system (`OracleRound.js`) — timer-based round lifecycle with configurable interval
- External price fetcher (`PriceFetcher.js`) — fetches BTC/USD, LTC/USD, DOGE/USD from CoinGecko and CoinMarketCap
- `ORACLE_PRICE_SUBMIT` gossip message — validators broadcast price submissions each round
- `oracle_submissions` table for persisting price submissions per round
- `getoraclesubmissions` JSON-RPC method for oracle diagnostics
- `startOracle()` and `getOracle()` methods on XChainHub
- New env vars: `ORACLE_ROUND_INTERVAL`, `ORACLE_SUBMISSION_WINDOW`, `COINGECKO_API_KEY`, `COINMARKETCAP_API_KEY`, `PRICE_FETCH_TIMEOUT`

## [1.3.0] - 2026-04-06

### Added
- Ed25519 validator identity (`ValidatorIdentity.js`) — message signing and signature verification using Node.js built-in crypto
- `validators` table for validator registry (signing pubkey, addr, status)
- `registervalidator` JSON-RPC method for bootstrap validator registration
- Leader rotation in PBFT consensus — deterministic leader per sequence number from sorted validator set
- View change protocol — `PBFT_VIEW_CHANGE` and `PBFT_NEW_VIEW` messages for leader failover on timeout
- Signature verification in PeerManager — incoming messages verified against registered validator pubkeys
- `SIGNING_PRIVKEY_HEX` env var for Ed25519 private key
- `REQUIRE_SIGNATURES` env var (default false) — when true, rejects unsigned P2P messages

### Changed
- PeerManager broadcasts now include Ed25519 signature in envelope `sig` field (when identity is configured)
- Consensus quorum now uses registered validator set size (not transient peer count)
- Consensus timeout now triggers view change (leader rotation) instead of simple rejection

## [1.2.0] - 2026-04-06

### Added
- PBFT consensus engine (`Consensus.js`) for config writes
- Config updates now go through PRE_PREPARE → PREPARE → COMMIT consensus round
- Quorum calculation: `2f+1` where `f = floor((N-1)/3)` (tolerates f Byzantine faults)
- `consensus_state` table for persistent sequence number tracking
- Single-node fallback: when no peers are connected, writes apply directly (backward compatible)
- Configurable consensus timeout via `PBFT_TIMEOUT` env var (default 30s)
- `startConsensus()` and `getConsensus()` methods on XChainHub
- `applyConfig()` method on XChainHub (separates consensus proposal from DB write)

## [1.1.0] - 2026-04-06

### Added
- P2P gossip layer (`PeerManager.js`) for validator-to-validator communication
- WebSocket-based peer connections with exponential backoff reconnection
- Heartbeat broadcasts every 15 seconds for liveness detection
- Message deduplication with configurable TTL
- Gossip relay (flood-fill) for small validator networks
- WS ping/pong dead connection detection (30-second interval)
- `p2p_peers` table for peer tracking
- New env vars: `P2P_PORT`, `P2P_HOST`, `SEED_NODES`, `P2P_VALIDATOR_ADDR`, etc.
- P2P is optional — hub works without it for backward compatibility
- `getPeerManager()` method on XChainHub for higher-layer access (PBFT, oracle)

## [1.0.0] - 2026-04-06

### Changed
- **BREAKING:** Replace LevelDB storage with MariaDB for platform alignment
- Replace `LevelUpDb.js` with `db.js` (MariaDB Database class with connection pool, circuit breaker, exponential backoff)
- Update `XChainHub.js` constructor to accept DB connection parameters
- Update `api.js` with required env var validation and proper DB initialization
- Replace `body-parser` with built-in `express.json()`
- Remove `/data/` volume from Dockerfile (LevelDB no longer used)
- Bump version to 1.0.0

### Added
- MariaDB `configs` table schema (`src/sql/configs.sql`)
- Auto-create database and tables on startup
- Required environment variable validation (`HUB_DB_HOST`, `HUB_DB_PORT`, `HUB_DB_NAME`, `HUB_DB_USER`, `HUB_DB_PASS`, `HUB_PORT`)
- Circuit breaker with exponential backoff for DB connections
- `setParam()` with upsert (INSERT ... ON DUPLICATE KEY UPDATE)

### Removed
- `levelup` and `leveldown` dependencies
- `LevelUpDb.js` (replaced by `db.js`)

## [0.0.3] - 2026-03-25

### Added
- CHANGELOG.md to track project changes
