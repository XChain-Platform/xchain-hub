/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - Redaction-safe names for secret-bearing env vars
 *
 * An operator env file is read far more often than it is written: during an
 * incident, a venue rebuild, or a cred-parity check. Whatever reads it (a
 * terminal, a CI log, an assistant transcript) usually carries an automatic
 * redaction filter keyed on the variable NAME, and those filters key on
 * `_SECRET` / `_KEY` / `_TOKEN`. `HUB_DB_PASS` matches none of them, so on
 * 2026-07-23 a regtest relay hub's DB password was read out of
 * `~/relay-hub.env` in full . The value was regtest-only, but the
 * naming gap is not: the same file shape carries prod credentials.
 *
 * The fix is a name the filter catches. This module lets every secret the hub
 * reads be supplied under a `_SECRET` name, keeping the historical name as a
 * deprecated fallback so no deployment breaks on upgrade:
 *
 *   HUB_DB_SECRET   (preferred)  ->  HUB_DB_PASS   (legacy, still honoured)
 *
 * Both names set to DIFFERENT values is a hard error rather than a silent
 * precedence rule: that shape means a half-finished rename, and guessing which
 * one the operator meant is how a hub ends up authenticating against a stale
 * credential it was supposed to have rotated away from.
 *
 * Renaming the variable does not un-leak anything by itself. A name the filter
 * catches only stops the NEXT read from leaking; the credential that already
 * appeared in a transcript still has to be rotated.
 *
 ********************************************************************/

// Legacy name -> redaction-safe name. Explicit rather than derived from a
// suffix rule: `SIGNING_PRIVKEY_HEX` has no `_PASS` tail to rewrite, and a
// derivation clever enough to cover it would be harder to audit than the table.
const SECRET_ENV_ALIASES = Object.freeze({
    HUB_DB_PASS:                  'HUB_DB_SECRET',
    XCHAIN_PRICE_INDEXER_DB_PASS: 'XCHAIN_PRICE_INDEXER_DB_SECRET',
    SIGNING_PRIVKEY_HEX:          'SIGNING_PRIVKEY_SECRET'
});

/**
 * Resolve one secret env var by its legacy name, preferring the
 * redaction-safe alias.
 *
 * Returns the value, or undefined when neither name is set. An empty string is
 * treated as unset on the alias side so that `HUB_DB_SECRET=` in an env file
 * (docker --env-file writes empty values for unset keys) cannot mask a real
 * legacy value, but a legitimately empty password still resolves to '' when
 * only the legacy name is present.
 *
 * @param {string} legacyName          e.g. 'HUB_DB_PASS'
 * @param {object} [env=process.env]
 * @returns {string|undefined}
 */
function resolveSecretEnv(legacyName, env = process.env) {
    const aliasName = SECRET_ENV_ALIASES[legacyName];
    if (!aliasName) {
        throw new Error('resolveSecretEnv: unknown secret env var ' + legacyName +
            ' (add it to SECRET_ENV_ALIASES in src/secret-env.js)');
    }

    const aliasValue  = env[aliasName];
    const legacyValue = env[legacyName];
    const hasAlias    = aliasValue !== undefined && aliasValue !== '';
    const hasLegacy   = legacyValue !== undefined;

    if (hasAlias && hasLegacy && legacyValue !== '' && aliasValue !== legacyValue) {
        // Never include either value in the message: this string ends up in
        // stderr and in whatever collects it.
        throw new Error(aliasName + ' and ' + legacyName + ' are both set to different values. ' +
            'Remove ' + legacyName + ' (the deprecated name) once ' + aliasName + ' carries the current credential.');
    }

    if (hasAlias) return aliasValue;
    return hasLegacy ? legacyValue : undefined;
}

/**
 * Names of secrets still being supplied under a deprecated, filter-invisible
 * name. Callers log these once at boot so an operator finds out from their own
 * hub, not from a leaked transcript.
 *
 * @param {object} [env=process.env]
 * @returns {Array<{legacy: string, preferred: string}>}
 */
function deprecatedSecretEnvNames(env = process.env) {
    const found = [];
    for (const [legacyName, aliasName] of Object.entries(SECRET_ENV_ALIASES)) {
        const aliasValue  = env[aliasName];
        const legacyValue = env[legacyName];
        const hasAlias  = aliasValue !== undefined && aliasValue !== '';
        const hasLegacy = legacyValue !== undefined && legacyValue !== '';
        if (hasLegacy && !hasAlias) found.push({ legacy: legacyName, preferred: aliasName });
    }
    return found;
}

module.exports = { SECRET_ENV_ALIASES, resolveSecretEnv, deprecatedSecretEnvNames };
