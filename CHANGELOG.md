# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- A hub whose signing key is outside the chain-effective signer set no longer broadcasts into rounds it cannot sign or opens checkpoint rounds it cannot lead, and says so once per set change; it keeps receiving, relaying and serving.
- The PRICE v0 payload builder now accepts a coinPair-keyed pair the same as a pair-keyed one, matching the hub's other two v0 payload copies byte for byte.
- A bridge source leg finalizes as exactly one transfer however many snapshot heights it spans, so the destination chain mints or releases once per lock or burn.

## [0.18.0] - 2026-09-11

### Changed
- The attestation provider fetch timeout default is 20000 ms, so a healthy but slow provider no longer leaves a round short of the bodies its redundancy asked for; `CONFIGURATION.md` documents it alongside `ATTESTATION_PROPOSER_SEEN_MAX`.

### Fixed
- Price snapshots carry the clock of the block their PRICE batch landed in, earliest landing wins, and the stamp is mirrored to every following indexer so a fee is priced only from rounds whose batch has landed.
- The proposed snapshot height is resolved and bounded once, before the clamp-reference gate and every other reader of it.
- A refused relay row no longer counts as a materialized request, gated on the reject-slot activation through a copy of the indexer's twin module, so the honest relay it still owes is sent.
- A deferred reward attestation whose still-shallow txid draws a rejected status verdict retries until its TTL instead of being dropped.
- An unreachable peer is backed off past a minute and reported once per backoff step at warn level.
- A spend-guard reservation the store cannot record fails closed and rolls back.
- Capability snapshots are derived per capability off signing identity rather than the peer manager, and the price-ingest fence is keyed on network as well as source chain, with a migration adding the column.
- The Docker image no longer tries to bake a `.env` file, so the build succeeds on the legacy builder and configuration reaches the container as environment only.

## [0.17.0] - 2026-09-10

### Added
- A hub that does not run oracle consensus derives `price` capability snapshots from its own Bitcoin view, so its indexer can validate on-chain PRICE batches instead of refusing every one.
- That derivation now covers `oracle_publish`, `cross_chain` and `attestation` too, so a chain-only node stops refusing every ATTEST and storing every archive head unverified.
- The publisher status names which kind of non-publisher a hub is, so a silent oracle is read as configured rather than broken.
- New federation write `retractattestbatch` clears a batch link the chain has un-landed.
- The leader-rotation silent-slot skip is gated on its own activation height, keyed on the request block: testnet 152400, mainnet unratified, regtest genesis.

### Changed
- Mainnet activation gates are armed at genesis under the 2026-09-09 ruling, proven identity on the measured mainnet history and on a from-genesis replay witness.
- The oracle clamp reference is a function of the round being judged rather than each hub's own timer, so two hubs judge one PROPOSE against the same reference.
- The oracle clamp reference realignment is gated on its own activation height, keyed on the round's BTC block height: testnet 152400, mainnet unratified, regtest genesis.
- A standalone hub honours `HUB_NETWORK`, so its ingest gates resolve on the network it declares instead of a default.
- A signer module declares the chains it serves, and a publisher on another rail stays unwired instead of loading a signer that cannot sign for it.

### Fixed
- An unknown chain on the tip push and on the four other durable pushes is answered as a JSON-RPC error instead of a success result, so a mis-pointed indexer learns it is being refused.
- The oracle publisher restores its last-published markers from the durable table at startup, so a restart no longer re-publishes windows the chain already carries.
- A judge_model leader stamps the round's effective_time when the winner is established rather than at proposal, so an otherwise unanimous round no longer times out on the follower propagation floor.
- A rotating catch-up cursor, a backlog cadence and attempt-plus-age retirement drain the buffered oracle window backlog instead of re-attempting the head of it forever.
- The p2p message-listener ceiling is sized from the subscriber roster, so a large federation no longer trips the max-listeners warning.
- The wider `validator_rewards` and `capability_snapshots` unique keys are built before the old narrow ones are dropped, so a failed widen can no longer leave the table with no unique key at all.
- The attestation batch publisher retries a head wire the encoder refused before it was sent, instead of treating an unsent wire as broadcast.
- The archive election key binds the wrapper checkpoint only, and a stale batch sequence converges upward instead of forking hubs whose tables differ.
- Leader rotation steps over a slot it has proven silent instead of freezing on it, so a round with every capable hub proposing no longer times out for the rest of the request's life.
- A truncated capability snapshot is refused in count mode as well as weighted mode, so a mirror can no longer read a partial signer set as complete.
- A standalone hub in weighted mode reads the federation's stake snapshot from the pinned staking bundle, so it persists the validators' oracle frames instead of skipping every unregistered sender.

## [0.16.3] - 2026-09-09

### Fixed
- Every silent oracle round exit (a scheduler number gap, a restart between submission and finalization, a bare seat return) leaves a structured `round_lost` record and a skipped row, so a round with no snapshot row is explained instead of vanishing.
- A catch-up sweep wire may spend the change of a wire the same publish pass already sent, bounded by pass, `ORACLE_PUBLISH_SELF_CHAIN_MAX_DEPTH` (default 4), the encoder UTXO cap and readable confirmation depth, so a publisher with a buffered backlog no longer fails on dust once its confirmed outputs are spent.

### Changed
- The pushed-tip line past `MAX_TIP_AGE_S` logs at info and names the Bitcoin block gap, since every such line measured over 24h was a real gap and not a fault.

## [0.16.2] - 2026-09-09

### Fixed
- The hub image installs the llm provider's CLI, so a validator configured for the spawn transport can serve an llm attestation instead of failing every fetch.


## [0.16.0] - 2026-09-08

- Testnet activation heights sized: zero-confirmation ATTEST service from block 151800 and ROLLCALL v1 gates from epoch 152208.
### Added
- Cross-chain match, call and capability-snapshot rows carry the hash of Bitcoin block 1 on the hub's chain (`btc_chain_id`), learned from the Bitcoin indexer's tip push, so a mirror can refuse rows from a chain it does not follow.
- The PRICE batch publisher sheds buffered rounds once their batch lands (on every push, and by asking the landing chain's indexer before each catch-up sweep), so a hub restarted onto a full buffer no longer re-publishes windows the chain already carries.
- Attestation requests are served the block they are mined in, with one headroom slot in the responsible set from the start, above a new zero-confirmation activation height; the hub refuses to boot if that height is armed below the mirror or widening heights.

### Fixed
- A request this hub already finalized is refused before the provider is called when it is re-polled while waiting to bind, so a re-mine or a slow bind no longer pays the provider again; `finalized_skip_count` counts those refusals.
- ROLLCALL v1 carries the consensus gates the publisher's build knows, published for epochs at or above a new gates activation height, with the pair cap per action sized to the list.

### Changed
- The pending-request poll runs every 3 seconds instead of 15, and attestation stats report provider fetches and fetch-cache hits.

## [0.15.2] - 2026-09-07

### Fixed
- The hourly ATTEST response batch anchors on the BTC tip the attestation poll observed when no chain tip was pushed to the hub, so a validator without its own Bitcoin indexer can lead and co-sign batches instead of deferring every window.


## [0.15.0] - 2026-09-07

### Added
- ATTEST responses are written to a hub mirror table, gossiped to every hub, verified before they are stored, and served over the snapshot route and stream; inert until the response-mirror activation height, which is armed on regtest only.
- Each hour's finalized responses are published as a signed ATTEST batch on Dogecoin, keyed on the signed effective time, and landed batches are accepted back.
- The response's effective time is inside the signed canonical and the body is capped before anyone signs it.
- `getattestationresponsibleset` answers which validators a request drew.
- A lost-round watchdog per seat, oracle round presence over RPC, and a stake-share watcher that warns before the weighted commit gate halts rounds.
- A frozen bitcoin tip that pins the checkpoint cadence slot is metered and reported.
- A regtest venue can arm ROLLCALL from its environment.
- SWEEP and CALLBACK are priced on the unified fee schedule.

### Fixed
- A price window that closed while the hub was down is published on restart.
- Oracle takeover holds off while a co-signed batch may still be in flight.
- Local callers are exempt from the per-IP cap and a 429 is answered as JSON-RPC.
- `getallconfigs` redacts secret-bearing params; `include_secrets` needs its own key tier.
- Out-of-band oracle round numbers are refused at ingest and stored ones are reported through diagnostics.
- The hub refuses to start when a canonical capability has no configured stake floor.
- The LLM credential gate reports ready only once a real token is present.
- `hub_url` stays on the pushed checkpoint block instead of being dropped with `self_sync`.
- The derive block is carried through the anchor reward activation copy.
- The attestation forward-margin override is read by its documented name.
- Closing the hub stops its attestation and consensus engines and unsubscribes them.
- The snapshot routes and the WS stream serialize BIGINT the same way.
- mariadb moved off the cleartext-credential advisory range with the floor pinned in the dependency gate.

### Activation
- The ATTEST response mirror activates on Bitcoin testnet at block 151324 and on regtest from genesis. Mainnet is unratified and the legacy on-chain response path runs there byte for byte.
- ROLLCALL activates on Bitcoin testnet at block 151200, which the chain has already passed, so it is live from the moment a node updates. Mainnet is unratified.
- Both change state derived from existing bytes on testnet, so an updated node and one still on 0.14.0 judge a mirrored response differently once one lands. Update every indexer and hub together.

## [0.14.0] - 2026-09-02

### Added
- Validators gossip a consensus-rules digest on the heartbeat and warn when a peer, or this node itself, is applying different flag-day heights.

### Fixed
- A stalled attestation round now widens its responsible set as the request's window elapses, so a single validator that never answers can no longer strand every request assigned to it.

### Activation
- Attestation responsible-set widening activates on Bitcoin testnet at block 150780 and on regtest from genesis. Mainnet is unratified and the rule is inert there. Below the height, and on an unratified network, behaviour is byte-for-byte unchanged.
- This train changes state derived from existing bytes, so nodes on either side of the height disagree once a widened response lands. Upgrade every indexer and hub before the height.

## [0.12.0] - 2026-08-30

### Added
- ROLLCALL: hubs sign each epoch, gossip the signatures, and an elected publisher lands the roll call on chain.
- Anchors publish one bundle per network per cycle, replacing one anchor per chain.

### Fixed
- The MariaDB connector moves to 3.5.3, closing three high-severity advisories against the pinned 3.5.2.
- A bundle the attestation round could not attest is deferred rather than published unattested.
- The anchor rail runs on start, spends only confirmed inputs, and watches its own transaction ids.
- An adopted anchor no longer reports as one this hub paid for.
- Silent consensus drops report a reason and a counter.
- A stalled checkpoint cadence is recorded rather than passing as one tick in sixty.
- JSON-RPC batches are capped, and the testnet confirmations override has a floor.

### Changed
- ROLLCALL is inert on regtest: arming a network commits every BTC indexer on it to a wired DOGE peer, which a single-coin regtest venue cannot have.
- The roll call stays idle on a network nobody has armed.
- Credential scrubbing covers prefixed names and the token after a bearer prefix.
- Service logging routes through the shared log shim, one line per console call.

## [0.12.3] - 2026-09-01

### Fixed
- A peer that is not in the effective signer set is told so, instead of being reported as having sent an invalid signature; a validator whose stake has not activated yet no longer reads as a broken key.
- A hub running in validator mode reports whether its own key is in the signer set, and says so again when it is admitted.

## [0.12.0] - 2026-08-30

### Added
- ROLLCALL: signed epochs, gossip, and an elected publisher that lands them; inert on a network nobody has armed.
- The anchor wire version set restarts, bundling on 0 and the archive head on 1.

### Fixed
- A stalled checkpoint cadence gets a record, and not one tick in sixty.
- A bundle the attestation round could not attest is deferred rather than published.
- An adopted anchor no longer reports as one this hub paid for.
- Silent PBFT drops now say so, with a reason and a counter.
- JSON-RPC batches are capped and the testnet confirmations override is floored.

### Security
- Credential scrubbing covers names carrying a prefix, and the token after Bearer.

## [0.11.0] - 2026-08-25

### Fixed
- Closed a gap in oracle price consensus where a hub that missed or sat out a round clamped against a stale price reference instead of the shared last-finalized value.
- The oracle slash-detection band now widens only in rounds where the price clamp actually bound, so a genuine market move no longer flags every honest submitter.
- Attestation rounds now fail closed on an unsupported consensus strategy instead of running it with safety checks disabled.
- Updated the BTC mainnet reward pool address.
- Re-pinned the testnet genesis for BTC, LTC, and DOGE at the current chain tips ahead of the public testnet announcement.
- Code-review round fixes across oracle consensus, attestation, and observability code.

### Security
- Closed a gap where the attestation fetch provider's private-address allow list and the price source's consensus-uniform overrides were honored on every network instead of being restricted to regtest.

## [0.10.0] - 2026-08-18

### Added
- A read RPC for slash proposals that lists every status, so a pending accusation is visible as unadjudicated rather than hidden, and returns each accusation's evidence as a digest instead of verbatim text.
- Service database descriptors accept `self_sync`, so a consumer that maintains its own checkpoint mirror can declare that mode.

### Changed
- Refreshed the bundled chain-registry snapshot, which carries the per-coin donation defaults.

### Fixed
- Retraction consensus fails closed when the capability-snapshot persist fails, instead of proceeding on a snapshot that was never durably recorded.
- Oracle publishing and attestation relay reserve their spend budget before an awaited broadcast, so concurrent sends can no longer spend past the per-window ceiling.
- A round the spend ceiling declined no longer leaves an intent-only record for startup to quarantine.
- Every publisher refuses phase one of a two-transaction encoding before anything is signed, because those pipelines have no reveal and would otherwise broadcast an undecodable payload.
- A spent spend budget is reported as a transient could-not-judge that is re-judged when the window rolls, rather than reading as a vendor outage.
- Oracle diagnostics carry per-read error flags, so a failed read no longer renders like a clean round.
- The price-snapshot read carries the price-age bound alongside its watermark.
- The LLM envelope rejects a non-string system prompt and a non-positive-integer version ceiling.
- The block-pinned election query falls back to the local capability snapshot and warns when membership stays unresolved, instead of electing an empty set and anchoring nothing in silence.
- A refused proposal consumes its rotation slot, so a hub that was not the leader for one slot can propose again instead of retrying the same slot forever.
- Publishers forward the whole UTXO set to the encoder rather than a truncated fetch.
- The reorg history read is capped server-side at 500 rows instead of trusting its callers.
- The full-node verifier set resolves at the raw epoch height again; the earlier buried-height change misattributed epoch participation and is withdrawn in lockstep with the indexer.
- Corrected an anchor-reward header that pointed maintainers at the hub's own copy instead of the indexer twin.
- Review-round fixes across the reward split, the round gates and the capability select-back.
- Code-review round fixes across consensus, federation, and API code (two rounds, 68 files).

### Security
- Raised the brace-expansion and js-yaml dependency floors and the advisory guards that pin them.

## [0.9.0] - 2026-08-14

First release of the XChain Platform release train. Every component in the train
now shares one platform version, so "XChain 0.9.0" names an exact, reproducible
set of software rather than a rough era.

### Changed
- Adopted the platform version stream. This component moves from `2.2.18` to
  `0.9.0`. **The number is lower but the release is newer**: the platform stream
  starts at 0.9.0 for the testnet series, and 1.0.0 is reserved for mainnet.

<!-- ------------------------------------------------------------------------
     Versions BELOW this line are this component's own legacy stream, from
     before the release train. They are kept for history and are NOT comparable
     to the platform versions above: a higher legacy number is an older release.
     ------------------------------------------------------------------------ -->

## [2.2.18] - 2026-08-13

### Fixed
- A durable broadcast intent survives a crash between an accepted anchor send and its txid stamp, avoiding a duplicate DOGE fee on the next flush.
- Governance now bounds the absolute slash-deviation threshold, not just its rate of change, so a passing proposal cannot leave the hub refusing to boot.
- Timer-driven passes now carry the same in-flight guard as their sibling loops.
- A governance default temperature is clamped to the vendor-accepted range instead of being sent verbatim and rejected.
- The fetch-meta allowlist no longer lets a judge-only model reach a real fetch through the judge fallback chain.
- The transient-status docstring now names both consumers instead of only the wrong one.
- The Docker image pins node:22-bookworm instead of a floating tag that could silently move off Node 22.
- Stake-weighted quorum now rejects a validator entry with a missing or non-numeric weight instead of lowering the quorum denominator.
- envelope.max_tokens and temperature are now range-validated at the boundary instead of forwarded raw to vendor APIs.
- XchainPriceSource now logs its abstention instead of silently dropping a derived pair that fails its price bound.
- PRICE_MAX and ORACLE_DEVIATION_THRESHOLD are now covered by the cross-repo value-equality gate.
- NODEPROOF verifier-signing now builds its canonical PASS list with the pinned byte comparator.
- Dropped an unused resolveHubLlmAuth import.
- CORS_ORIGIN now accepts a comma-separated allowlist matched per-origin instead of echoing a header no browser accepts.

### Changed
- The hub now refuses to boot when HUB_API_KEY is unset unless keyless operation is explicitly declared.

### Added
- Consensus-input fetch failures now alert: failed validator-set reads are classified and counted, and a sustained streak degrades /health.

### Fixed
- Review-round fixes: per-broadcast spend-ceiling gate, FULLNODE config whitelist, oracle/checkpoint observability counters, several provider-contract fixes, oracle source_address bounds, and checkpoint persist fail-closed.

### Added
- Added the standard license header to three unit test files that were missing it, matching the rest of the suite.
- Added an env override for the credential resolver's last-resort config-dir fallback, so hermetic tests and constrained deploys can disable it.
- Added LLM attestation outage resilience: failed rounds publish audit rows, the round leader rotates, and the LLM provider now supports multiple vendors with a fallback ladder.
- Armed four BTC-anchored activation flags in lockstep with the indexer.
- Armed cross-chain royalty activation on mainnet, byte-identical with the indexer.
- Added a sensitive-read auth tier so a config read that carries DB credentials requires an API key.
- Added a public wallet/SDK bootstrap endpoint serving the chain descriptors, signed when the hub has an identity.
- Added read-only JSON-RPC methods for votes and validator capabilities, plus filters on the proposals list.
- Added a byte-parity test across three canonicalization paths.
- The cross-chain dispatch test now runs against the indexer's real response shape instead of a mock.

### Fixed
- The oracle publisher's at-most-once guard is now durable across restarts, so a restart can no longer re-broadcast an already-published round.
- A failed database query now always raises instead of silently returning an empty result.
- Async timer and event handlers that reach the database now catch and log instead of risking a crash.
- The anchor archive backfill now re-broadcasts stamped rows on the mirror feed instead of leaving them null until the next bootstrap.
- The chain-registry endpoint now serves permissive CORS so browser wallets can fetch it cross-origin.
- Regenerating the RPC spec no longer drops methods that were only hand-added to the JSON file.
- Corrected a stale comment describing the health-check config-fetch counters.
- Sibling-gated conformance checks now fail loudly instead of silently skipping themselves in CI.
- Wired a retention-rounds setting into P2P config so the documented "0 disables pruning" behavior actually works.

## [2.2.17] - 2026-07-16

### Fixed
- The anchor-reward flag-day gate now reads the reward's own network at every call site.
- A database read fault during sequence load now raises instead of resetting the sequence to 0.
- An attestation-consensus leader now requires its own valid proposal before re-signing.
- The config-delta cursor boundary is now inclusive, matching the documented merge contract.
- The oracle latest-mode snapshot query now keys correctly on source, coin, tick, and fiat.

## [2.2.16] - 2026-06-20

### Added
- Added multi-fiat price-fetch test coverage across all supported pairs.
- Startup now reconciles column drift on existing tables, adding new columns and relaxing nullability safely.
- Added .env.example and CONFIGURATION.md documenting every hub environment variable.
- Added chain-tip staleness reporting to the oracle diagnostics endpoint.
- Added a health RPC method that reports database and circuit-breaker state.

### Changed
- Renamed the hub's default Claude CLI config directory to match the platform convention.
- The BTC indexer-URL resolver now reads the renamed config key.
- Pinned the mariadb dependency to an exact version for reproducible installs.
- The round-skipped log now states why a round was skipped.
- The oracle publisher now falls back to hub config for its queue path and retry settings.
- The validator chains column is now schema-declared instead of added by ad-hoc DDL.
- Removed an unused, no-op message listener from the attestation round.
- getallconfigs now supports an incremental cursor instead of always returning the full table.
- getallconfigs now returns the last committed sequence number alongside the config list.
- Aligned the mariadb driver version platform-wide, removing version drift.
- A stale indexer tip beyond a lag threshold now degrades gracefully instead of locking a stale validator set.
- Upgraded express-rate-limit to v8 and switched to its new option names.
- Renamed the rate-limit env var; operators must migrate to the new name.

### Fixed
- Capability minimum-stake thresholds are now block-anchored across every consumer so every hub locks the same qualifying set.
- The validator-set snapshot cache now flushes correctly on a minimum-stake governance change.
- The checkpoint-anchor election now fails closed when the eligible publisher set is empty.
- A relayed cross-chain call's effective time now carries a forward margin so live and replaying nodes agree on it.
- Judge-model attestations at higher redundancy are now fulfillable by every responsible validator.
- The v1 anchor archive is now signed and quorum-checked at the correct snapshot block.
- Anchor rewards now dedup by validator so a publish-failover overlap can no longer mint two rewards for one checkpoint.
- The API key is optional again at boot, with a loud warning when unset, fixing keyless crash-loops.
- Lowered the attestation wire size ceiling to fit the encoder's payload limit.
- Removed an unused fee-payment-mode override that no longer matched actual behavior.
- The CoinMarketCap price fetch now retries transient errors with the same backoff as its CoinGecko counterpart.
- An oracle round now survives a leader crashing mid-round via a fallback proposer.
- A timed-out reorg consensus round now emits its discarded details before removal.
- The reorg consensus quorum is now locked at round start instead of recomputed live.
- Cross-chain attestation quorum is now locked to a deterministic snapshot instead of drifting live.
- The oracle aggregator now counts at most one price per sender per pair, closing an outlier-skew path.
- A late-arriving attestation commit is now buffered and replayed instead of dropped.
- Attestation PBFT now rejects an oversized peer-supplied body before decoding it.
- Price aggregation now scopes its lock-window check per source chain.
- Price aggregation now binds the originating chain instead of hardcoding it, with a backfill migration included.
- Oracle freshness counters now rehydrate on restart and surface a staleness flag on /health.
- The default-broadcast path now sends the correct case for the encoder's address-type parameter.
- The oracle fallback-proposer legitimacy check now uses the receiver's own observations instead of attacker-controlled input.
- The attestation publisher now rejects an oversized payload before it enters the durable write-ahead log.
- Attestation PBFT quorum now computes over the responsible-set size instead of the full validator count.
- Consensus now authenticates a new-view message before advancing, closing a leader-steering attack.
- Consensus no longer broadcasts a prepare for a digest it cannot commit.
- Consensus view-change acceptance now uses the round-locked quorum instead of recomputing it live.
- A finalized attestation response now survives a leader crash via a durable write-ahead log and failover sweep.
- Two unbounded in-memory structures are now bounded, one as a ring buffer and one with a TTL eviction.
- Unified the oracle price ceiling under one constant so ingestion and aggregation agree.
- The single-node oracle finalize path no longer double-stores and double-broadcasts a round.
- Byte-equality attestation agreement now requires a simple majority instead of full BFT threshold.
- The PBFT pending-view-change map is now pruned so failed view changes cannot leak memory.

### Security
- Every PBFT quorum is now floored at a simple majority, fixing a degenerate case that let one validator finalize at N=3.
- Peer-message auth now fails closed when the validator registry is unavailable, and PBFT engines now reject unregistered senders.
- The HTTP-fetch attestation provider now refuses non-public targets, closing an SSRF path.
- Pushed price rounds are now re-verified at the hub instead of trusted from the pusher.
- The reorg consensus engine now rejects unregistered senders in its alert, prepare, and commit handlers.

## [2.2.12] - 2026-05-29

### Fixed
- Decimal comparison now uses exact BigInt arithmetic instead of floats, so stakes differing by one satoshi no longer collapse together.
- Governance bounds-change ratios are now evaluated with exact BigInt arithmetic instead of floats.

## [2.2.11] - 2026-05-29

### Fixed
- Attestation-round pending-request paging now uses a stable cursor and a TTL-evicted seen-set instead of always re-reading the oldest entries.

## [2.2.10] - 2026-05-29

### Changed
- Dependency installs are now reproducible via a committed lockfile and npm ci in the Docker build.

## [2.2.9] - 2026-05-29

### Security
- Hub-to-indexer federation reads now authenticate with an API key header.

## [2.2.8] - 2026-05-29

### Fixed
- Cross-chain attestation quorum is now locked at round creation instead of re-derived live, matching the other consensus engines.

## [2.2.7] - 2026-05-29

### Fixed
- The capability snapshot now sends the hub's governance-sourced minimum stake, making the hub authoritative over the indexer's local config.

## [2.2.6] - 2026-05-29

### Fixed
- Capability minimum-stake governance changes now take effect without a hub restart.

## [2.2.5] - 2026-05-29

### Fixed
- Oracle fallback-proposer election no longer diverges under uneven gossip, using an authoritative submission list instead of local state.

## [2.2.4] - 2026-05-29

### Fixed
- The publisher default-broadcast path now uses the correct address format instead of one that crashed every broadcast.

## [2.2.3] - 2026-05-28

### Fixed
- Governance proposal tallying now uses a single deterministic leader, ending a split-brain where hubs could disagree on the outcome.
- Proposal tallying now guards its status write so a stale result cannot overwrite an already-finalized proposal.
- Governance now emits the event name the hot-reload listener expects, so a passed proposal triggers a config reload.

## [2.2.2] - 2026-05-28

### Changed
- getFeeQuote now sources the gas price from config instead of a hardcoded constant.

### Fixed
- getFeeQuote now covers the full gas schedule instead of a partial one.

## [2.2.1] - 2026-05-28

### Security
- Pinned qs to remediate a moderate denial-of-service advisory (GHSA-q8mj-m7cp-5q26).

## [2.2.0] - 2026-05-28

### Added
- Added a JSON-RPC method for an indexer to retract price rows after a block rollback.
- Added retraction support to the price aggregator, including per-table deleted-row counts.
- Added a broadcaster method forwarding retraction events to subscribed indexers.

### Changed
- Wired the new retraction event to the broadcaster alongside the existing insert path.

## [2.1.0] - 2026-04-08

### Added
- Added a price aggregator that receives validated price actions from all chains and writes unified snapshots.
- Added an oracle publisher that broadcasts finalized prices with leader rotation and balance monitoring.
- Added a minimal encoder client used by the oracle publisher's default pipeline.
- Added a broadcaster forwarding price events to indexer sync clients with backpressure handling.
- Added a table for cross-chain fiat oracle prices with a lock-window column.
- Added chain-tip storage used to anchor oracle rounds to real block heights.
- Added JSON-RPC write methods for indexers to push chain state and validated price actions.
- Added REST snapshot endpoints with pagination for incremental indexer bootstrap.
- Added a WebSocket channel streaming price-table events, requiring authentication.
- Added multi-validator signature aggregation to oracle consensus.
- Added canonical payload-signing helpers matching the indexer's format.

### Changed
- Oracle snapshots now carry the real BTC chain tip instead of a hardcoded value.
- Oracle round finalization now threads chain-tip values through to storage and the finalized event.
- The oracle round executor now reads the real chain tip and threads it through finalization.
- Rewrote the price fetcher to cover more coins and fiat currencies.
- The skipped-round path now sources its pair list from the price fetcher instead of a hardcoded list.
- The price snapshots table now tracks the source chain and action index.
- Reward distribution now pushes records to the indexer so claims can find them.
- The hub now starts the price aggregator and broadcaster in every mode.
- The API server now uses an explicit HTTP server with a WebSocket upgrade handler.

### Fixed
- Oracle snapshots now use the real chain tip instead of a hardcoded value, restoring cross-node determinism.
- Price snapshots now use the block's real timestamp instead of wall-clock time.
- The finalized-round event now carries chain height, time, and signatures.
- Updated the README with a version badge, test badges, and documentation links.

## [2.0.12] - 2026-04-06

### Added
- Added a comprehensive regression suite covering consensus, oracle, cross-chain, swap, reorg, governance, P2P, database, and incentive behavior.
- Added tiered regression test execution for fast per-commit, PR, and nightly runs.

## [2.0.11] - 2026-04-06

### Added
- Added mutation testing infrastructure targeting the source tree.

## [2.0.10] - 2026-04-06

### Added
- Added a chaos engineering suite covering database, oracle, consensus, compound-failure, and API-abuse scenarios.

## [2.0.9] - 2026-04-06

### Added
- Added a performance and load testing suite covering API, oracle, P2P, and database behavior under load.

## [2.0.8] - 2026-04-06

### Added
- Added API key authentication, rate limiting, CORS restriction, and input validation across write and list endpoints.
- Added a security test suite covering the new hardening measures.

### Changed
- P2P messages now require signatures by default.
- Object query arguments now serialize safely instead of using a lossy string conversion.
- Invalid P2P JSON is now logged instead of silently discarded.

## [2.0.7] - 2026-04-06

### Added
- Added a property-based fuzz testing suite covering consensus, oracle, P2P, and governance invariants.

### Fixed
- Fixed Infinity values leaking through oracle price aggregation.
- Fixed a crash when the P2P layer received non-object JSON.
- Fixed message ID collisions under high throughput by switching to a cryptographic UUID.
- Fixed a prototype-pollution path in the fee-quote gas lookup.

## [2.0.6] - 2026-04-06

### Added
- Added a boundary test suite covering extreme input edges across consensus, oracle, governance, and P2P.

## [2.0.5] - 2026-04-06

### Added
- Added an end-to-end test suite covering oracle, config, attestation, governance, reorg, fee, and multi-node scenarios.

## [2.0.4] - 2026-04-06

### Added
- Added a smoke test suite for quick service health checks.

## [2.0.3] - 2026-04-06

### Added
- Added an integration test suite covering cross-module data flows with a real database.

## [2.0.2] - 2026-04-06

### Added
- Added a comprehensive unit test suite covering all source modules.

### Changed
- The default test script now runs the unit test suite.

## [2.0.1] - 2026-04-06

### Changed
- Rewrote the README to match the platform's standard format.

## [2.0.0] - 2026-04-06

### Added
- Added a governance engine for off-chain PBFT voting on parameter changes.

### Changed
- Major version bump: governance completes the decentralized hub architecture.

## [1.9.0] - 2026-04-06

### Added
- Added a swap lifecycle tracker for cross-chain swaps.

## [1.8.0] - 2026-04-06

### Added
- Added a reorg handler with PBFT consensus for cross-chain reorg propagation.

## [1.7.0] - 2026-04-06

### Added
- Added a cross-chain attestation engine with PBFT-based consensus.

## [1.6.0] - 2026-04-06

### Added
- Added a reward tracker and slash detector for oracle round participants.

## [1.5.0] - 2026-04-06

### Added
- Added an oracle consensus engine with trimmed-median price aggregation.

## [1.4.0] - 2026-04-06

### Added
- Added a price oracle round system with an external price fetcher.

## [1.3.0] - 2026-04-06

### Added
- Added Ed25519 validator identity, leader rotation, and view-change protocol.

## [1.2.0] - 2026-04-06

### Added
- Added a PBFT consensus engine for config writes.

## [1.1.0] - 2026-04-06

### Added
- Added a P2P gossip layer for validator-to-validator communication.

## [1.0.0] - 2026-04-06

### Changed
- Replaced LevelDB storage with MariaDB for platform alignment.

### Added
- Added the MariaDB configs table schema and startup auto-migration.

### Removed
- Removed the levelup and leveldown dependencies.

## [0.0.3] - 2026-03-25

### Added
- Added CHANGELOG.md to track project changes.
