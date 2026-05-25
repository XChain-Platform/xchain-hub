/*********************************************************************
 *
 * XChain Hub - Capability Self-Test: attestation
 *
 * Determines whether this hub is operationally ready to serve
 * attestation requests. Validates that at least one provider is
 * available. Providers live in xchain-hub/src/providers/ (added by the
 * attestation framework — see specs/2026-05-24_external-attestation-framework.md).
 *
 * Config shape:
 *   { attestation: { providers: { http_get: {}, llm: { api_key: '...' } } } }
 *
 * Phase 0 keeps this lightweight: http_get is implicitly available (no
 * config needed); llm requires api_key. Phase 1 adds richer per-provider
 * probes via the provider modules themselves.
 *
 ********************************************************************/

exports.selfTest = async (config) => {
    let entry = (config && config.attestation) || {};
    let providers = entry.providers || {};
    let active = [];

    // http_get: implicitly available — needs only outbound HTTPS
    // If operator has explicitly disabled http_get via providers.http_get = false, skip it
    if (providers.http_get !== false) {
        active.push('http_get');
    }

    // llm: requires api_key
    if (providers.llm && providers.llm.api_key) {
        active.push('llm');
    }

    if (active.length === 0) {
        return { ok: false, reason: 'no attestation providers available' };
    }
    return { ok: true, providers: active };
};
