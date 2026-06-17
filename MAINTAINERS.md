# Maintainers

This file lists the people responsible for `xchain-hub`, what each of them owns, and how to escalate issues that need a human's attention beyond what `CONTRIBUTING.md` and `SECURITY.md` cover.

The XChain Platform is in pre-launch development and ships under a single primary maintainer today. As contributors take on durable responsibility for areas of the codebase, they will be added here. This is a conventional MAINTAINERS file (an open-source norm used by distros and downstream packagers), not an aspirational org chart.

---

## Primary maintainer

| Role | Name | GitHub | Areas |
|---|---|---|---|
| Lead | J-Dog | [@J-Dog](https://github.com/J-Dog) | Everything: config oracle, price aggregation, cross-chain coordination, attestation, validator federation, API, releases |

Contact:

- General and non-sensitive: open an issue at <https://github.com/XChain-platform/xchain-hub/issues>.
- Code of Conduct: `conduct@dankest.llc` (per `CODE_OF_CONDUCT.md`).
- Security disclosures: GitHub Private Vulnerability Reporting, or `security@dankest.llc` (per `SECURITY.md`).

---

## Areas of responsibility

Until additional maintainers join, the lead owns every area below. The table is here so a future contributor (or downstream packager) can see what each area entails when scoping a contribution.

| Area | What it covers |
|---|---|
| Oracle price submission and aggregation | `OracleRound.js`, `OracleConsensus.js`, `OraclePublisher.js`, `PriceAggregator.js`, `PriceFetcher.js`, trimmed-median logic, fee-quote conversion |
| Cross-chain coordination and attestation | `CrossChainEngine.js`, `CrossChainCallEngine.js`, `AttestationRound.js`, `AttestationConsensus.js`, `AttestationPublisher.js`, `AttestationSpotChecker.js`, external providers under `src/providers/` |
| Config and service-discovery surface | `XChainHub.js`, `Consensus.js`, service registry tables, PBFT config writes, `CONFIGURATION.md` |
| Validator federation | `ValidatorIdentity.js`, `PeerManager.js`, `CapabilityRegistry.js`, `CapabilitySnapshot.js`, `stake_weighted_quorum.js`, `RewardTracker.js`, `SlashDetector.js`, `FullNodeChallengeRound.js`, governance (`Governance.js`) |
| JSON-RPC API | `src/api.js` and the full method surface (config, validators, oracle, attestations, swaps, reorgs, governance) |
| Database layer | MariaDB schema and migrations under `migrations/`, `src/db.js`, circuit breaker, connection pool |
| Tests | The layered suites under `test/` (unit, integration, e2e, fuzz, chaos, boundary, smoke, regression, performance) |
| Documentation | `README`, `SECURITY`, `CODE_OF_CONDUCT`, `CONTRIBUTING`, `MAINTAINERS`, `CHANGELOG`, `CONFIGURATION.md` |

---

## Adding a maintainer

A contributor becomes a maintainer when they have:

1. Sustained contribution in a specific area for at least one release cycle (typically 2 to 3 weeks of active work).
2. Reviewed and merged at least three PRs from outside contributors.
3. Demonstrated awareness of the project's conventions: raw parameterized SQL with no ORM, the `Keep a Changelog` format, Node 22 as the pinned runtime, and PBFT consensus correctness (quorum changes and oracle config are consensus-adjacent and require extra scrutiny).

Open a PR adding the new maintainer to the table above with their GitHub handle and area(s) of responsibility. The lead approves and merges.

## Removing a maintainer

A maintainer steps down by opening a PR removing their row. The lead also removes a maintainer who has been inactive for six months or who violates the Code of Conduct, after a written notice period.

---

## Escalation paths

If you cannot reach the relevant area maintainer within a reasonable window:

| Situation | Escalate to |
|---|---|
| Active security incident | `security@dankest.llc` (per `SECURITY.md`) |
| Oracle price manipulation or cross-chain coordination compromise | Open a public issue tagged `security` AND email `security@dankest.llc` |
| Code-of-conduct concern | `conduct@dankest.llc` (per `CODE_OF_CONDUCT.md`) |
| PR has been open without review for 14+ days | Comment `@J-Dog` on the PR; if no response within 7 more days, open an issue tagged `governance` with the PR link |

---

## Decision-making

The lead makes final calls on:

- Oracle and consensus-adjacent config (quorum thresholds, min-submission policy, capability stake minimums).
- Cross-chain protocol behavior and coordination rules.
- Database schema and migration changes.
- Release timing and version policy.
- Adopting a new heavy dependency.
- Code-of-conduct enforcement, and maintainer additions or removals.

Smaller calls (bug fixes, additions within an existing area, documentation, dependency bumps inside an existing minor) go through PR review by the area maintainer.

---

## Cross-project relationships

| Project | Relationship |
|---|---|
| [`xchain-indexer`](https://github.com/XChain-platform/xchain-indexer) | Indexers push chain state and stake data to the hub; hub oracle rounds reference chain tips from the indexer |
| [`xchain-explorer`](https://github.com/XChain-platform/xchain-explorer) | Explorer polls the hub for service config and live oracle prices |
| [`xchain-sync`](https://github.com/XChain-platform/xchain-sync) | Sync replicates hub-backed tables to validator nodes |
| [`xchain-documentation`](https://github.com/XChain-platform/xchain-documentation) | Protocol spec: ACTION definitions, oracle/attestation protocol, cross-chain coordination |

The hub maintainer is not automatically a maintainer of those sibling projects. Cross-project changes go through each project's own review process.
