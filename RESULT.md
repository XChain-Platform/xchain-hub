# Lane report: cx-xc-5703-p1

## Status: BLOCKED, the row cannot land alone

## Files touched
- bin/pins/at1-suite-titles.json (regenerated after merging origin/develop; the pin conflict was resolved by regenerating with the full dependency set installed)
- src/db/schema/sql_migration_files.js and test/unit/db/schema/sql_migration_files.test.js are unchanged from the earlier rounds
- The 'sync trunk' merge commit carries develop's own files, as the brief required

## Tests
- `npx mocha --timeout 20000 --exit test/unit/db/schema/sql_migration_files.test.js`: 6 pass, 0 fail, 1 pending (the twin check skips because the decoder sibling checkout is absent here)
- `node bin/suite-title-map.js --compare bin/pins/at1-suite-titles.json --rename-map bin/pins/suite-title-renames.json`: identity holds
- `npx mocha --timeout 20000 --exit bin/test/reachability.test.js`: 11 pass, 1 fail

## The failing test
`reaches every db mixin in this tree through the db home index` (bin/test/reachability.test.js:268) fails with
`dead = ['src/db/schema/sql_migration_files.js']`. The test requires every file under src/db/ to be runtime-reachable from the hub.
The new file is required by nothing, because the row forbids wiring it into src/db.js or the schema modules. Develop passes this test only because it has no such file.
The reason given by the push gate is correct.

No fix exists inside the writable surfaces. Making the file reachable needs one of:
1. wiring it from a schema module (XC-5703's port), or
2. a reachability.js or test exemption (bin/ is outside the surfaces).

Recommendation: land this row together with, or after, the XC-5703 wiring, or have the orchestrator widen the surface for one require or exemption.
