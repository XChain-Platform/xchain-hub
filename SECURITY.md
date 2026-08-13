# Security Policy

`xchain-hub` is the config oracle and cross-chain action coordinator for the XChain Platform. It serves protocol configuration to every service in the fleet, aggregates price-oracle submissions from validators via trimmed-median and PBFT consensus, and coordinates cross-chain actions and attestations. A flaw in oracle price submission or aggregation distorts fee calculations across the network; a flaw in cross-chain coordination or quorum handling can corrupt attestation state or allow a malicious peer to influence consensus. We treat reports seriously and respond fast.

If you've found a security issue, please **do not open a public issue or pull request**. Use the private channels below.

---

## How to report

### Preferred: GitHub Private Vulnerability Reporting

Open a draft advisory at:

<https://github.com/XChain-Platform/xchain-hub/security/advisories/new>

This is the fastest path. The advisory is private until we publish it.

### Alternative: Email

Email **security@dankest.llc** with:

- A description of the issue and the threat it poses.
- Reproduction steps or a proof-of-concept (a crafted oracle submission, attestation payload, or API call that triggers the bug).
- The affected version (see `CHANGELOG.md` and the version badge in `README.md`) and the network you tested against (mainnet / testnet / regtest, and which chain).
- Any patches or mitigations you'd like considered.

For sensitive reports, encrypt the email body to our PGP key. The fingerprint will be published alongside the first signed release artifact; until then, the email channel is acceptable for first contact and we will coordinate an encrypted exchange before you share proof-of-concept details.

We do not currently offer a paid bug bounty. We do offer public credit in release notes and the advisory itself, unless you prefer to remain anonymous.

---

## Response timeline

| Stage | Target |
|---|---|
| Initial acknowledgement | within 72 hours |
| Triage + severity assignment | within 7 days |
| Fix or mitigation in master | within 30 days for high/critical, 90 days for lower severities |
| Coordinated public disclosure | up to 90 days from initial report, or sooner if a fix has shipped and operators are protected |

If we cannot meet a timeline, we will tell you why and propose a new one. We will not silently let a report age.

---

## Scope

### In scope

- Integrity of oracle price submission and aggregation: any path where a malicious or malfunctioning validator can bias the trimmed-median result, bypass `ORACLE_MIN_SUBMISSIONS`, or corrupt a finalized price snapshot.
- Cross-chain coordination and attestation logic: quorum handling, PBFT prepare/commit/view-change flows, per-chain-pair validator filtering, and the block-boundary quorum snapshot that locks the qualified validator set.
- The external attestation framework: the `ATTEST` v0 request pipeline, provider fetch and PBFT consensus for `ATTEST` v1 responses, and the byte-equality and LLM provider paths.
- The hub JSON-RPC API surface (all categories: config, validators, oracle, fees, cross-chain, swaps, reorgs, governance).
- Any path where a malicious submitter, rogue hub peer, or crafted API call can corrupt config state, manipulate governance votes, or influence slash/reward accounting.
- Denial-of-service via crafted oracle submissions, P2P gossip messages, or API calls that crash, hang, or exhaust resources.
- SQL construction and parameterization against the MariaDB layer.

### Out of scope

- Validity of the underlying chain data fed to the hub (report against `xchain-decoder` or `xchain-indexer` as appropriate).
- The operator's own MariaDB configuration, host hardening, or network exposure.
- Bugs in downstream services consuming hub output (report against those repos, unless the root cause is clearly the hub).
- Vulnerabilities in the underlying coin nodes (`bitcoind` / `litecoind` / `dogecoind`); report those to their respective projects.
- Compromise of upstream npm dependencies (we mitigate via audit + review, but a backdoor in a dep is the dep author's incident, though we still want to hear about it).
- Attacks that require the operator's database credentials or shell access to the hub host.

If you are unsure, send the report anyway and we will tell you whether it falls in scope.

---

## What we ask

- Give us a reasonable window to fix before disclosing publicly. The 90-day ceiling is firm; earlier is fine once a fix has shipped and operators are protected.
- Test against `regtest` or `testnet` where possible (the `xchain-regtest-miner` plus a local stack make this easy). Mainnet proofs-of-concept are accepted but should be the minimum needed.
- Do not run automated scanners against shared XChain infrastructure in a way that would impact availability for other operators.
- Do not access data, or attempt to access data, beyond what is needed to demonstrate the issue.

---

## What we will do

- Confirm receipt within the SLA above.
- Keep you informed as triage and remediation proceed.
- Credit you in the advisory and `CHANGELOG.md` entry, on request.
- Coordinate a CVE assignment when the severity warrants it.
- Publish a post-fix advisory describing the issue, the fix, and the affected version range.

---

## Versions covered

We ship security fixes against the latest release on `master`. Older releases are unsupported. The current version is recorded in `CHANGELOG.md` and the badge in `README.md`.

---

Last reviewed: 2026-06-16.
