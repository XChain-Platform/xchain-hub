// secret env vars must be supplied under a name that automatic
// redaction matches (`_SECRET`), with the historical `_PASS` name still read so
// an upgrade does not take a running hub down.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SECRET_ENV_ALIASES, resolveSecretEnv, deprecatedSecretEnvNames } = require('../../src/secret-env');

describe('secret-env', function () {

    describe('alias table', function () {

        it('maps every hub secret to a redaction-safe name', function () {
            const preferred = Object.values(SECRET_ENV_ALIASES);
            assert.ok(preferred.length >= 3, 'expected the known hub secrets in the table');
            for (const name of preferred) {
                assert.ok(/_(SECRET|KEY|TOKEN)$/.test(name),
                    name + ' is not a name the redaction filter matches');
            }
        });

        it('never maps a secret onto a name that is itself filter-invisible', function () {
            for (const legacy of Object.keys(SECRET_ENV_ALIASES)) {
                assert.ok(!/_(SECRET|KEY|TOKEN)$/.test(legacy),
                    legacy + ' already matches the filter and needs no alias');
            }
        });
    });

    describe('resolveSecretEnv', function () {

        it('prefers the _SECRET name', function () {
            const env = { HUB_DB_SECRET: 'new', HUB_DB_PASS: 'new' };
            assert.strictEqual(resolveSecretEnv('HUB_DB_PASS', env), 'new');
        });

        it('reads the _SECRET name when it is the only one set', function () {
            assert.strictEqual(resolveSecretEnv('HUB_DB_PASS', { HUB_DB_SECRET: 'only' }), 'only');
        });

        it('still reads the deprecated name so existing deployments keep booting', function () {
            assert.strictEqual(resolveSecretEnv('HUB_DB_PASS', { HUB_DB_PASS: 'legacy' }), 'legacy');
        });

        it('returns undefined when neither name is set', function () {
            assert.strictEqual(resolveSecretEnv('HUB_DB_PASS', {}), undefined);
        });

        it('treats an empty _SECRET as unset rather than masking a real legacy value', function () {
            // docker --env-file materialises unset keys as empty strings, so an
            // empty alias must not shadow the value the hub is actually using.
            assert.strictEqual(resolveSecretEnv('HUB_DB_PASS', { HUB_DB_SECRET: '', HUB_DB_PASS: 'live' }), 'live');
        });

        it('keeps an explicitly empty legacy password as empty', function () {
            assert.strictEqual(resolveSecretEnv('HUB_DB_PASS', { HUB_DB_PASS: '' }), '');
        });

        it('rejects a half-finished rename (both names, different values)', function () {
            assert.throws(
                () => resolveSecretEnv('HUB_DB_PASS', { HUB_DB_SECRET: 'rotated', HUB_DB_PASS: 'stale' }),
                /both set to different values/);
        });

        it('never puts either value in the conflict message', function () {
            try {
                resolveSecretEnv('HUB_DB_PASS', { HUB_DB_SECRET: 'rotated-value', HUB_DB_PASS: 'stale-value' });
                assert.fail('expected a throw');
            } catch (err) {
                assert.ok(!err.message.includes('rotated-value'), 'message leaked the new secret');
                assert.ok(!err.message.includes('stale-value'), 'message leaked the old secret');
            }
        });

        it('rejects a name that is not in the alias table', function () {
            assert.throws(() => resolveSecretEnv('NOT_A_HUB_SECRET', {}), /unknown secret env var/);
        });

        it('covers the P2P signing seed and the price-source DB password too', function () {
            assert.strictEqual(resolveSecretEnv('SIGNING_PRIVKEY_HEX', { SIGNING_PRIVKEY_SECRET: 'seed' }), 'seed');
            assert.strictEqual(
                resolveSecretEnv('XCHAIN_PRICE_INDEXER_DB_PASS', { XCHAIN_PRICE_INDEXER_DB_SECRET: 'pw' }), 'pw');
        });
    });

    describe('deprecatedSecretEnvNames', function () {

        it('reports a secret still supplied under the deprecated name', function () {
            assert.deepStrictEqual(deprecatedSecretEnvNames({ HUB_DB_PASS: 'x' }),
                [{ legacy: 'HUB_DB_PASS', preferred: 'HUB_DB_SECRET' }]);
        });

        it('reports nothing once the rename is done', function () {
            assert.deepStrictEqual(deprecatedSecretEnvNames({ HUB_DB_SECRET: 'x' }), []);
        });

        it('ignores a deprecated name left behind empty', function () {
            assert.deepStrictEqual(deprecatedSecretEnvNames({ HUB_DB_SECRET: 'x', HUB_DB_PASS: '' }), []);
        });
    });

    describe('api.js wiring', function () {

        const api = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'api.js'), 'utf8');

        it('does not read any aliased secret straight off process.env', function () {
            for (const legacy of Object.keys(SECRET_ENV_ALIASES)) {
                assert.ok(!api.includes('process.env.' + legacy),
                    'api.js reads process.env.' + legacy + ' directly, bypassing the _SECRET alias');
            }
        });

        it('no longer demands the deprecated DB password name in REQUIRED_ENV', function () {
            const line = api.split('\n').find(l => l.includes('const REQUIRED_ENV'));
            assert.ok(line, 'REQUIRED_ENV not found in api.js');
            assert.ok(!line.includes('HUB_DB_PASS'),
                'REQUIRED_ENV still hard-fails a hub that supplies HUB_DB_SECRET');
        });
    });

    describe('shipped example env', function () {

        it('.env.example uses the redaction-safe names', function () {
            const example = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
            for (const [legacy, preferred] of Object.entries(SECRET_ENV_ALIASES)) {
                assert.ok(!new RegExp('^\\s*#?\\s*' + legacy + '=', 'm').test(example),
                    '.env.example still assigns ' + legacy + '; operators copy this file verbatim');
                void preferred;
            }
            assert.ok(/^HUB_DB_SECRET=/m.test(example), '.env.example must show HUB_DB_SECRET');
        });
    });
});
