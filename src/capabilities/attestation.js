/*********************************************************************
 *
 * XChain Hub - Capability Self-Test: attestation
 *
 * Determines whether this hub is operationally ready to serve attestation
 * requests. Probes the built-in provider modules' healthCheck() to verify
 * the hub can actually reach the upstream services each provider relies on.
 *
 * Config shape:
 *   { attestation: { providers: { http_get: false } } }
 *     - omit a key to enable the provider (the common case)
 *     - set a key to `false` to opt out of a provider on this hub
 *
 * Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md (§8)
 *
 ********************************************************************/

// Providers this self-test knows how to probe. Adding a new provider type
// (e.g. 'llm') goes here. Each module must export `healthCheck() -> { ok, error? }`.
const PROVIDER_PROBES = {
    http_get: require('../providers/http_get.js')
};

exports.selfTest = async (config) => {
    let entry     = (config && config.attestation) || {};
    let optouts   = entry.providers || {};
    let active    = [];
    let failed    = [];

    for (let id of Object.keys(PROVIDER_PROBES)) {
        if (optouts[id] === false) continue;
        let mod = PROVIDER_PROBES[id];
        if (!mod || typeof mod.healthCheck !== 'function') {
            failed.push(id + ': no healthCheck()');
            continue;
        }
        try {
            let r = await mod.healthCheck();
            if (r && r.ok) active.push(id);
            else            failed.push(id + ': ' + (r && r.error ? r.error : 'unknown'));
        } catch (e) {
            failed.push(id + ': probe threw ' + (e && e.message ? e.message : String(e)));
        }
    }

    if (active.length === 0) {
        return { ok: false, reason: 'no attestation providers healthy: ' + failed.join('; ') };
    }
    let res = { ok: true, providers: active };
    if (failed.length > 0) res.failed = failed;
    return res;
};
