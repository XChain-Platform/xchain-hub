'use strict';

const { callRpc } = require('./rpcClient');

/**
 * Generic poll helper with exponential backoff.
 * @param {function} checkFn - Async function that returns truthy when condition is met
 * @param {number} timeout - Max wait time in ms
 * @param {string} label - Description for error messages
 */
async function poll(checkFn, timeout, label) {
    let elapsed = 0;
    let delay = 100;
    while (elapsed < timeout) {
        let result = await checkFn();
        if (result) return result;
        await new Promise(r => setTimeout(r, delay));
        elapsed += delay;
        delay = Math.min(delay * 2, 2000);
    }
    throw new Error('Timeout waiting for ' + (label || 'condition') + ' after ' + timeout + 'ms');
}

/**
 * Wait for a finalized price snapshot for a given round to appear.
 */
async function waitForPriceSnapshot(port, round, timeout) {
    return poll(async () => {
        let res = await callRpc(port, 'getpricesnapshots', { limit: 50 });
        if (!res.result || !Array.isArray(res.result)) return null;
        let match = res.result.find(s => s.round_number === round && s.status === 'finalized');
        return match || null;
    }, timeout || 15000, 'price snapshot round ' + round);
}

/**
 * Wait for a price to be available for a coin pair.
 */
async function waitForPrice(port, coinPair, timeout) {
    return poll(async () => {
        let res = await callRpc(port, 'getprice', { coin_pair: coinPair });
        if (res.result && res.result.price && !res.result.error) return res.result;
        return null;
    }, timeout || 15000, 'price for ' + coinPair);
}

/**
 * Wait for an attestation to reach a given status.
 */
async function waitForAttestation(port, sourceChain, sourceActionIndex, status, timeout) {
    return poll(async () => {
        let res = await callRpc(port, 'getattestation', { source_chain: sourceChain, source_action_index: sourceActionIndex });
        if (res.result && res.result.status === status) return res.result;
        return null;
    }, timeout || 15000, 'attestation ' + sourceChain + ':' + sourceActionIndex + ' status=' + status);
}

/**
 * Wait for a swap to reach a given status.
 */
async function waitForSwapStatus(port, sourceChain, sourceActionIndex, status, timeout) {
    return poll(async () => {
        let res = await callRpc(port, 'getswap', { source_chain: sourceChain, source_action_index: sourceActionIndex });
        if (res.result && res.result.status === status) return res.result;
        return null;
    }, timeout || 15000, 'swap ' + sourceChain + ':' + sourceActionIndex + ' status=' + status);
}

/**
 * Wait for a governance proposal to reach a given status.
 */
async function waitForProposalStatus(port, proposalId, status, timeout) {
    return poll(async () => {
        let res = await callRpc(port, 'getproposal', { proposal_id: proposalId });
        if (res.result && res.result.proposal && res.result.proposal.status === status) return res.result;
        return null;
    }, timeout || 15000, 'proposal ' + proposalId + ' status=' + status);
}

module.exports = {
    poll,
    waitForPriceSnapshot,
    waitForPrice,
    waitForAttestation,
    waitForSwapStatus,
    waitForProposalStatus
};
