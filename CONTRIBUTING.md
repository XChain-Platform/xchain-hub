# Contributing to XChain Hub

Thanks for considering a contribution. `xchain-hub` is the config oracle and cross-chain coordinator for the XChain Platform, so correctness in oracle aggregation, PBFT consensus, and cross-chain coordination logic is as important as speed on every commit.

If you're reporting a security issue, **stop here** and read [`SECURITY.md`](./SECURITY.md) instead. Security reports go through a private channel.

---

## Quick links

- Project overview: [`README.md`](./README.md)
- Environment variables and database schema: [`CONFIGURATION.md`](./CONFIGURATION.md)
- Full component docs: the [`xchain-documentation`](https://github.com/XChain-platform/xchain-documentation/tree/master/components/hub) repository (architecture, configuration, API reference, operations)
- Disclosure policy: [`SECURITY.md`](./SECURITY.md)
- Code of Conduct: [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
- License: [`LICENSE.md`](./LICENSE.md) + [`NOTICE.md`](./NOTICE.md) (GNU Affero General Public License v3.0, dual-licensed)

---

## Repo layout in 30 seconds

```
xchain-hub/
├── src/                  hub core: API, consensus, oracle, cross-chain engine, P2P, governance
├── test/                 layered suites (unit, integration, e2e, fuzz, chaos, smoke, regression, performance)
├── CHANGELOG.md          authoritative version history
├── CONFIGURATION.md      all environment variables and schema details
├── SECURITY.md           private vulnerability disclosure
└── package.json          scripts + dependencies
```

---

## Setting up

### Prerequisites

- **Node.js 22** exactly. The platform pins Node 22 fleet-wide: the `mariadb` driver is ESM-only (Node 18 fails with `ERR_REQUIRE_ESM`), and newer majors are not validated against the stack. `engines.node` declares `>=22.0.0`; use 22.
- **MariaDB** reachable from the hub host for anything beyond unit tests.
- For integration and e2e runs, a running XChain stack (indexer, at least one coin node). The `xchain-regtest-miner` plus a regtest stack is the easiest local path.

### First-time install

```bash
git clone https://github.com/XChain-platform/xchain-hub.git
cd xchain-hub
npm install
```

Create a `.env` (see [`CONFIGURATION.md`](./CONFIGURATION.md) for the full key list). **Never commit a `.env` or any real credential.** Secrets live only in the local `.env`, loaded at runtime; never hard-code them into source, tests, or scripts.

---

## Running it

```bash
npm run api        # start the hub API server
```

The hub auto-creates the database and all tables on first startup. Without `P2P_VALIDATOR_ADDR` it runs in standalone config-oracle mode. Set the `P2P_*` and `SIGNING_PRIVKEY_HEX` variables (see `CONFIGURATION.md`) to activate the full validator stack.

---

## Tests

The hub runs a layered suite. Pick the tier that matches your change:

| Tier | Command | Needs external services |
|---|---|---|
| Smoke | `npm run test:smoke` | No |
| Unit | `npm test` | No |
| Security | `npm run test:security` | No |
| CI (unit, fast gate) | `npm run ci` | No |
| Integration | `npm run test:integration` | MariaDB |
| End-to-end | `npm run test:e2e` | Full stack |
| Fuzz | `npm run test:fuzz` | No |
| Chaos | `npm run test:chaos` | No |
| Regression | `npm run test:regression` (`:p0` / `:p0p1` variants) | No |
| Performance | `npm run test:perf` | No |

Run the no-external-services tiers before every commit; the README documents the full script catalogue. Changes to oracle aggregation, PBFT flows, quorum logic, or cross-chain coordination should come with security and fuzz coverage: these are consensus-adjacent code paths and correctness is paramount.

---

## Coding style

- **Plain JavaScript**, no TypeScript. Raw parameterized SQL via the `mariadb` driver, no ORM.
- **No linter is configured.** Match the style of the surrounding file: naming, structure, and comment density.
- **Comments are rare on purpose.** Don't restate what well-named code already says. Do comment a *why* that isn't obvious: a hidden invariant, a consensus-relevant constraint, a workaround with a reference.
- **Never use the em-dash character** in code, comments, or docs. Rewrite the sentence (a comma, colon, or parentheses) instead.
- **Two trailing spaces** on consecutive bold-label markdown lines so CommonMark renders the line break instead of collapsing them.
- **Oracle and consensus correctness matter.** Any change to price aggregation, PBFT prepare/commit/view-change, quorum snapshot locking, or cross-chain attestation must be accompanied by a clear explanation of why it preserves correctness under adversarial conditions.

---

## Commit messages

Match the existing log style: a concise subject line, then a short body explaining what changed and why.

- Branch off `master` and keep history linear (rebase, don't merge).
- One logical change per commit; don't batch unrelated work.
- **No `Co-Authored-By` trailers.** This is a project policy.
- **Never `--no-verify`.** If a hook fails, fix the cause; don't bypass it.

---

## Pull requests

CI is the smoke + unit gate. Before opening a PR:

1. Run the no-external-services tiers (`npm run ci`, `npm run test:security`) and confirm they pass.
2. Update `CHANGELOG.md` with a terse entry for your change.
3. Make sure `git status` is clean apart from intended changes (no `node_modules/`, no editor leftovers, no `.env`).
4. Open the PR with a clear title and a description of what changed and why.

For non-security bugs, open an issue at <https://github.com/XChain-platform/xchain-hub/issues/new>. For security bugs, see [`SECURITY.md`](./SECURITY.md).

---

## Code of Conduct

We follow our [Code of Conduct](./CODE_OF_CONDUCT.md), adapted from the Contributor Covenant 2.1. Be kind, assume good faith, and disagree without being a jerk.

---

Last reviewed: 2026-06-16.
