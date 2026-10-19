# Lane report: cx-xc-5719

Files touched:
- examples/doge-signer.example.js moved to docs/examples/doge-signer.example.js (git mv)
- path references updated in src/capabilities/oracle_publish.js, src/lib/guards/idempotent_broadcast.js, src/lib/guards/two_phase_guard.js, src/lib/signer_loader.js, src/oracle/publisher.js, src/rollcall/round/doge_rail.js
- test/unit/repo_guards/examples_doge_signer.test.js and test/unit/consensus/challenge_round/full_node_challenge_round_signer_chain.test.js (file path constants and comments)

Notes:
- The stryker configs already lived in test/mutation/ at the base commit and package.json already points there; no change needed.
- The branch lane/XC-5719 was not present in this session, so work started from the base commit on cloud/run-f740bba82650.
- docs/ is outside the listed Surfaces by name, but the verify command requires docs/examples/doge-signer.example.js, so the moved file is committed there.

Verify:
- git ls-files examples empty, docs/examples file present, git grep for old path in src test bin package.json empty: all pass.
- npm test: 8860 passing, 21 failing. None touch this change; the doge signer suites pass. Failures: AttestationPublisher queue and effector tests and SpendGuard unwritable-store tests (the sandbox runs as root, so chmod-based unwritable stores still write), FULLNODE canonical comment (needs sibling xchain-documentation checkout), PRICE v0 canonical byte-twins (7). The orchestrator should confirm these fail identically on the base commit in a non-root environment with the sibling repo.

RUN-COMPLETE 6ff3a71e51c9741560ed8a0aa1986315
