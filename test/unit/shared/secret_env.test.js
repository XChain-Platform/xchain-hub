// secret env vars must be supplied under a name that automatic
// redaction matches (`_SECRET`), with the historical `_PASS` name still read so
// an upgrade does not take a running hub down.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SECRET_ENV_ALIASES, resolveSecretEnv, deprecatedSecretEnvNames } = require('../../../src/secret_env');

{

    let registeraliasTable2;

    {

        function mapsEveryHubSecretToATest4() {
            const preferred = Object.values(SECRET_ENV_ALIASES);
            assert.ok(preferred.length >= 3, 'expected the known hub secrets in the table');
            for (const name of preferred) {
                assert.ok(/_(SECRET|KEY|TOKEN)$/.test(name),
                    name + ' is not a name the redaction filter matches');
            }
        }

        function neverMapsASecretOntoATest5() {
            for (const legacy of Object.keys(SECRET_ENV_ALIASES)) {
                assert.ok(!/_(SECRET|KEY|TOKEN)$/.test(legacy),
                    legacy + ' already matches the filter and needs no alias');
            }
        }

        function aliasTableSuite3() {
            it('maps every hub secret to a redaction-safe name', mapsEveryHubSecretToATest4);
            it('never maps a secret onto a name that is itself filter-invisible', neverMapsASecretOntoATest5);
        }

        registeraliasTable2 = function registerSuite() {
            describe('alias table', aliasTableSuite3);
        };

    }

    let registerresolvesecretenv6;

    {

        function prefersTheSecretNameTest8() {
            const env = { HUB_DB_SECRET: 'new', HUB_DB_PASS: 'new' };
            assert.strictEqual(resolveSecretEnv('HUB_DB_PASS', env), 'new');
        }

        function readsTheSecretNameWhenItTest9() {
            assert.strictEqual(resolveSecretEnv('HUB_DB_PASS', { HUB_DB_SECRET: 'only' }), 'only');
        }

        function stillReadsTheDeprecatedNameSoTest10() {
            assert.strictEqual(resolveSecretEnv('HUB_DB_PASS', { HUB_DB_PASS: 'legacy' }), 'legacy');
        }

        function returnsUndefinedWhenNeitherNameIsTest11() {
            assert.strictEqual(resolveSecretEnv('HUB_DB_PASS', {}), undefined);
        }

        function treatsAnEmptySecretAsUnsetTest12() {
            // docker --env-file materialises unset keys as empty strings, so an
            // empty alias must not shadow the value the hub is actually using.
            assert.strictEqual(resolveSecretEnv('HUB_DB_PASS', { HUB_DB_SECRET: '', HUB_DB_PASS: 'live' }), 'live');
        }

        function keepsAnExplicitlyEmptyLegacyPasswordTest13() {
            assert.strictEqual(resolveSecretEnv('HUB_DB_PASS', { HUB_DB_PASS: '' }), '');
        }

        function rejectsAHalfFinishedRenameBothTest14() {
            assert.throws(
                () => resolveSecretEnv('HUB_DB_PASS', { HUB_DB_SECRET: 'rotated', HUB_DB_PASS: 'stale' }),
                /both set to different values/);
        }

        function neverPutsEitherValueInTheTest15() {
            try {
                resolveSecretEnv('HUB_DB_PASS', { HUB_DB_SECRET: 'rotated-value', HUB_DB_PASS: 'stale-value' });
                assert.fail('expected a throw');
            } catch (err) {
                assert.ok(!err.message.includes('rotated-value'), 'message leaked the new secret');
                assert.ok(!err.message.includes('stale-value'), 'message leaked the old secret');
            }
        }

        function rejectsANameThatIsNotTest16() {
            assert.throws(() => resolveSecretEnv('NOT_A_HUB_SECRET', {}), /unknown secret env var/);
        }

        function coversTheP2pSigningSeedAndTest17() {
            assert.strictEqual(resolveSecretEnv('SIGNING_PRIVKEY_HEX', { SIGNING_PRIVKEY_SECRET: 'seed' }), 'seed');
            assert.strictEqual(
                resolveSecretEnv('XCHAIN_PRICE_INDEXER_DB_PASS', { XCHAIN_PRICE_INDEXER_DB_SECRET: 'pw' }), 'pw');
        }

        function resolvesecretenvSuite7() {
            it('prefers the _SECRET name', prefersTheSecretNameTest8);
            it('reads the _SECRET name when it is the only one set', readsTheSecretNameWhenItTest9);
            it('still reads the deprecated name so existing deployments keep booting', stillReadsTheDeprecatedNameSoTest10);
            it('returns undefined when neither name is set', returnsUndefinedWhenNeitherNameIsTest11);
            it('treats an empty _SECRET as unset rather than masking a real legacy value', treatsAnEmptySecretAsUnsetTest12);
            it('keeps an explicitly empty legacy password as empty', keepsAnExplicitlyEmptyLegacyPasswordTest13);
            it('rejects a half-finished rename (both names, different values)', rejectsAHalfFinishedRenameBothTest14);
            it('never puts either value in the conflict message', neverPutsEitherValueInTheTest15);
            it('rejects a name that is not in the alias table', rejectsANameThatIsNotTest16);
            it('covers the P2P signing seed and the price-source DB password too', coversTheP2pSigningSeedAndTest17);
        }

        registerresolvesecretenv6 = function registerSuite() {
            describe('resolveSecretEnv', resolvesecretenvSuite7);
        };

    }

    let registerdeprecatedsecretenvnames18;

    {

        function reportsASecretStillSuppliedUnderTest20() {
            assert.deepStrictEqual(deprecatedSecretEnvNames({ HUB_DB_PASS: 'x' }),
                [{ legacy: 'HUB_DB_PASS', preferred: 'HUB_DB_SECRET' }]);
        }

        function reportsNothingOnceTheRenameIsTest21() {
            assert.deepStrictEqual(deprecatedSecretEnvNames({ HUB_DB_SECRET: 'x' }), []);
        }

        function ignoresADeprecatedNameLeftBehindTest22() {
            assert.deepStrictEqual(deprecatedSecretEnvNames({ HUB_DB_SECRET: 'x', HUB_DB_PASS: '' }), []);
        }

        function deprecatedsecretenvnamesSuite19() {
            it('reports a secret still supplied under the deprecated name', reportsASecretStillSuppliedUnderTest20);
            it('reports nothing once the rename is done', reportsNothingOnceTheRenameIsTest21);
            it('ignores a deprecated name left behind empty', ignoresADeprecatedNameLeftBehindTest22);
        }

        registerdeprecatedsecretenvnames18 = function registerSuite() {
            describe('deprecatedSecretEnvNames', deprecatedsecretenvnamesSuite19);
        };

    }

    let registerapiJsWiring23;

    {

        const api = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'api.js'), 'utf8');

        function doesNotReadAnyAliasedSecretTest25() {
            for (const legacy of Object.keys(SECRET_ENV_ALIASES)) {
                assert.ok(!api.includes('process.env.' + legacy),
                    'api.js reads process.env.' + legacy + ' directly, bypassing the _SECRET alias');
            }
        }

        function noLongerDemandsTheDeprecatedDbTest26() {
            const line = api.split('\n').find(l => l.includes('const REQUIRED_ENV'));
            assert.ok(line, 'REQUIRED_ENV not found in api.js');
            assert.ok(!line.includes('HUB_DB_PASS'),
                'REQUIRED_ENV still hard-fails a hub that supplies HUB_DB_SECRET');
        }

        function apiJsWiringSuite24() {
            it('does not read any aliased secret straight off process.env', doesNotReadAnyAliasedSecretTest25);
            it('no longer demands the deprecated DB password name in REQUIRED_ENV', noLongerDemandsTheDeprecatedDbTest26);
        }

        registerapiJsWiring23 = function registerSuite() {
            describe('api.js wiring', apiJsWiringSuite24);
        };

    }

    let registershippedExampleEnv27;

    {

        function envExampleUsesTheRedactionSafeTest29() {
            const example = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.env.example'), 'utf8');
            for (const [legacy, preferred] of Object.entries(SECRET_ENV_ALIASES)) {
                assert.ok(!new RegExp('^\\s*#?\\s*' + legacy + '=', 'm').test(example),
                    '.env.example still assigns ' + legacy + '; operators copy this file verbatim');
                void preferred;
            }
            assert.ok(/^HUB_DB_SECRET=/m.test(example), '.env.example must show HUB_DB_SECRET');
        }

        function shippedExampleEnvSuite28() {
            it('.env.example uses the redaction-safe names', envExampleUsesTheRedactionSafeTest29);
        }

        registershippedExampleEnv27 = function registerSuite() {
            describe('shipped example env', shippedExampleEnvSuite28);
        };

    }

    function secretEnvSuite1() {
        registeraliasTable2();
        registerresolvesecretenv6();
        registerdeprecatedsecretenvnames18();
        registerapiJsWiring23();
        registershippedExampleEnv27();
    }

    describe('secret-env', secretEnvSuite1);

}
