/*********************************************************************
 *
 * XChain Hub - Capability Self-Test Modules
 *
 * Each module exports `selfTest(config) -> { ok: boolean, reason?: string }`.
 *
 ********************************************************************/

module.exports = {
    price:          require('./price.js'),
    cross_chain:    require('./cross_chain.js'),
    oracle_publish: require('./oracle_publish.js'),
    attestation:    require('./attestation.js')
};
