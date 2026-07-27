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
 * XChain Hub - boot auth posture 
 *
 * Decides, from env alone, whether the hub may boot with its write
 * surface unauthenticated. Pure and side-effect free so the decision is
 * unit-testable; api.js does the logging and the process.exit.
 *
 * The hub's write methods (updateconfig, registervalidator, reportreorg,
 * the push* consensus inputs) drive the config oracle and validator
 * roster that the whole federation reads. Keyless, they are callable by
 * anyone who can reach the port. That used to boot with a console
 * warning on every non-validator hub, which is the fail-open default
 * the 2026-06-24 deep review called out: one forgotten env var on one
 * box turns a hardened service into an open write surface, and nothing
 * refuses.
 *
 * So the default is inverted: no key means REFUSE. Keyless operation
 * stays possible (single-host regtest, a hub behind a private network
 * or an authenticating proxy) but it must be DECLARED with
 * HUB_ALLOW_UNAUTHENTICATED=true. xchain-node's ConfigService sets that
 * declaration automatically for a managed deploy with no key in the
 * host env, so this does not crash-loop managed stacks the way a blind
 * hard-require of HUB_API_KEY would (the over-tightening that hit the
 * indexer at 771880c and the encoder at e2bf7c4 pre-launch).
 *
 ********************************************************************/

// Write methods named in the refusal so the operator sees what is open rather
// than an abstract "write surface". Kept short: the full set lives in api.js.
const EXAMPLE_WRITE_METHODS = 'updateconfig / registervalidator / reportreorg';

// Evaluate the boot-time auth posture.
//   apiKey               - HUB_API_KEY (string, '' when unset)
//   allowUnauthenticated - HUB_ALLOW_UNAUTHENTICATED parsed to a boolean
//   validatorMode        - true when P2P_VALIDATOR_ADDR is set
//   sensitiveReadAuth    - false when HUB_SENSITIVE_READ_AUTH=0
// Returns { refuse, fatal, warnings }. `fatal` is non-null only when refuse.
function evaluateAuthPosture(opts) {
    opts = opts || {};
    let apiKey               = opts.apiKey || '';
    let allowUnauthenticated = opts.allowUnauthenticated === true;
    let validatorMode        = opts.validatorMode === true;
    let sensitiveReadAuth    = opts.sensitiveReadAuth !== false;
    let warnings             = [];

    if (!apiKey) {
        if (!allowUnauthenticated) {
            return {
                refuse: true,
                fatal: 'REFUSING TO BOOT: HUB_API_KEY is not set, so the hub\'s write methods (' +
                    EXAMPLE_WRITE_METHODS + ' and the push* consensus inputs) would accept ' +
                    'UNAUTHENTICATED calls from anyone who can reach this port' +
                    (validatorMode
                        ? ', letting them drive consensus-affecting writes on a VALIDATOR hub.'
                        : ', letting them corrupt the config oracle and validator roster the whole ' +
                          'federation reads.') +
                    ' Set HUB_API_KEY (and the same value on the clients that write to this hub), or, ' +
                    'if this hub is genuinely unreachable from outside a trusted network, declare it with ' +
                    'HUB_ALLOW_UNAUTHENTICATED=true.',
                warnings: warnings
            };
        }
        warnings.push('WARNING: HUB_API_KEY is not set and HUB_ALLOW_UNAUTHENTICATED=true, so write methods (' +
            EXAMPLE_WRITE_METHODS + ' and the push* consensus inputs) and WebSocket subscriptions are ' +
            'UNAUTHENTICATED by explicit operator declaration' +
            (validatorMode ? ' ON A VALIDATOR HUB' : '') +
            '. This is only safe behind a private network or an authenticating proxy; set a strong ' +
            'HUB_API_KEY for any shared or public-facing deployment.');
    } else if (allowUnauthenticated) {
        // Not dangerous, but a stale flag left behind after a key was introduced
        // reads as "this hub is keyless" to the next operator who greps for it.
        warnings.push('NOTE: HUB_ALLOW_UNAUTHENTICATED is set but HUB_API_KEY is also set, so the hub is ' +
            'keyed and the flag has no effect. Remove it to avoid implying the write surface is open.');
    }

    // The inverse hole is quieter and easier to miss: a keyed hub with the
    // sensitive-read escape hatch flipped serves getallconfigs (every service's
    // DB user/pass) to ANY caller while writes look locked down (AU-4).
    if (apiKey && !sensitiveReadAuth) {
        warnings.push('WARNING: HUB_SENSITIVE_READ_AUTH=0 with HUB_API_KEY set: getallconfigs (returns DB ' +
            'credentials) is readable WITHOUT a key. This escape hatch is for staged rollout/rollback only; ' +
            'unset HUB_SENSITIVE_READ_AUTH to re-enforce.');
    }

    return { refuse: false, fatal: null, warnings: warnings };
}

module.exports = { evaluateAuthPosture };
