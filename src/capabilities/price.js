/*********************************************************************
 *
 * XChain Hub - Capability Self-Test: price
 *
 * Determines whether this hub is operationally ready to sign PRICE v0
 * snapshots. Pragmatic configuration check — live source probing happens
 * in PriceFetcher during normal operation.
 *
 * Config shape:
 *   { price: { sources: ['coingecko', 'coinmarketcap'], fiats: ['USD', ...] } }
 *
 ********************************************************************/

exports.selfTest = async (config) => {
    let entry = (config && config.price) || null;
    if (!entry) {
        return { ok: false, reason: 'price config missing' };
    }
    let sources = entry.sources || [];
    if (!Array.isArray(sources) || sources.length === 0) {
        return { ok: false, reason: 'price.sources empty (no price feed configured)' };
    }
    let fiats = entry.fiats || [];
    if (!Array.isArray(fiats) || fiats.length === 0) {
        return { ok: false, reason: 'price.fiats empty (no fiat currencies configured)' };
    }
    return { ok: true };
};
