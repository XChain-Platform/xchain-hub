/*********************************************************************
 *
 * XChain Hub - Capability Self-Test: cross_chain
 *
 * Determines whether this hub is operationally ready to attest to
 * cross-chain events. Verifies the operator has configured at least
 * one chain with an RPC endpoint. Live RPC connectivity is checked by
 * CrossChainEngine during normal operation.
 *
 * Config shape:
 *   { cross_chain: { chains: { BTC: { rpc: '...' }, LTC: { rpc: '...' } } } }
 *
 ********************************************************************/

exports.selfTest = async (config) => {
    let entry = (config && config.cross_chain) || null;
    if (!entry) {
        return { ok: false, reason: 'cross_chain config missing' };
    }
    let chains = entry.chains || null;
    if (!chains || typeof chains !== 'object' || Object.keys(chains).length === 0) {
        return { ok: false, reason: 'cross_chain.chains empty (no chains configured)' };
    }
    for (let chainName of Object.keys(chains)) {
        let chainCfg = chains[chainName];
        if (!chainCfg || typeof chainCfg !== 'object') {
            return { ok: false, reason: 'cross_chain.chains.' + chainName + ' is not an object' };
        }
        if (!chainCfg.rpc) {
            return { ok: false, reason: 'cross_chain.chains.' + chainName + '.rpc missing' };
        }
    }
    return { ok: true };
};
