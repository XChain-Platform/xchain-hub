/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Hub - capability snapshot proof transport.
 *
 ********************************************************************/

'use strict';

const { snapshotCheckpointBlock } = require('../../consensus/snapshot_checkpoint/canonical.js');
const { parseCapabilityProofQuery } = require('./capability_snapshot_proof/params.js');
const { createMissLog } = require('./capability_snapshot_proof/miss_log.js');
const {
    createUpstreamBudget, resolveProofRpm, upstreamRetryAfterMs
} = require('./capability_snapshot_proof/upstream_budget.js');

const PUBKEY = /^[0-9a-fA-F]{64}$/;

function configuredCapabilities(hub, p2pConfig) {
    const config = (hub && hub.p2pConfig) || p2pConfig || {};
    return Object.keys(config.CAPABILITIES || {});
}

function defaultPubkeys(rows) {
    if (!Array.isArray(rows)) return null;
    const pubkeys = [...new Set(rows.map(row => row && row.signing_pubkey))];
    if (pubkeys.length < 1 || pubkeys.length > 256 || pubkeys.some(pubkey => !PUBKEY.test(pubkey)))
        return null;
    return pubkeys;
}

// One BTC indexer call. Resolves { proof } (null when the indexer had no
// usable answer) or { retryAfterMs } when the indexer refused this hub's
// address with a 429; any other failure throws and the route answers 503.
async function fetchProof(ctx, params) {
    const { hub, axios } = ctx;
    const url = await hub.resolveIndexerUrl('BTC');
    if (!url) return { proof: null };
    const headers = typeof hub.btcIndexerHeaders === 'function'
        ? hub.btcIndexerHeaders()
        : { 'Content-Type': 'application/json' };
    let response;
    try {
        response = await axios.post(url, {
            jsonrpc: '2.0', method: 'getcapabilitystakeproof', params, id: 1
        }, { headers, timeout: 15000 });
    } catch (error) {
        const retryAfterMs = upstreamRetryAfterMs(error);
        if (retryAfterMs === null) throw error;
        return { retryAfterMs };
    }
    const data = response && response.data;
    if (!data || data.error || !data.result || data.result.error) return { proof: null };
    return { proof: data.result };
}

// 429 with Retry-After in whole seconds. The body keeps the { error } shape
// the mirror clients already read beside 404 and 503.
function rateLimited(res, retryAfterS) {
    res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterS))));
    return res.status(429).json({ error: 'PROOF_RATE_LIMITED' });
}

function sleep(ms) {
    return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

function checkpointBody(snapshotBlock, capability, checkpoint, proof) {
    return {
        snapshot_block: snapshotBlock,
        capability,
        checkpoint: {
            chain: checkpoint.chain,
            network: checkpoint.network,
            block_index: checkpoint.block_index,
            block_hash: checkpoint.block_hash,
            state_root: checkpoint.state_root,
            state_root_version: checkpoint.state_root_version,
            validator_signatures: checkpoint.validator_signatures,
        },
        proof,
    };
}

function mountCapabilitySnapshotProof(app, ctx) {
    const { hub, HUB_NETWORK, p2pConfig } = ctx;
    const missLog = createMissLog();
    // One budget per mounted hub: every client's proof fetch draws from it,
    // so the total this hub sends the BTC indexer stays under its per-IP limit.
    const budget = ctx.proofBudget || createUpstreamBudget({ rpm: resolveProofRpm(ctx.hubConfig) });
    app.get('/hub-db/snapshot/capability_snapshot_proof', async (req, res) => {
        const parsed = parseCapabilityProofQuery(req.query, configuredCapabilities(hub, p2pConfig));
        if (parsed.error) return res.status(400).json(parsed);

        try {
            let pubkeys = parsed.pubkeys;
            if (pubkeys === null) {
                const rows = await hub.db.findCapabilitySnapshotsBySnapshotBlockAndCapability(
                    parsed.snapshotBlock, parsed.capability);
                pubkeys = defaultPubkeys(rows);
                if (pubkeys === null) return res.status(400).json({ error: 'BAD_PARAMS' });
            }

            const network = (hub && hub.network) || HUB_NETWORK;
            const blockIndex = snapshotCheckpointBlock(parsed.snapshotBlock, network);
            const checkpoint = await hub.db.getSnapshotCheckpoint('BTC', network, blockIndex);
            if (!checkpoint) {
                missLog.report(hub.db, parsed.snapshotBlock, blockIndex);
                return res.status(404).json({ error: 'SNAPSHOT_NOT_YET_CHECKPOINTED' });
            }

            const slot = budget.reserve();
            if (!slot.ok) return rateLimited(res, slot.retryAfterS);
            await sleep(slot.waitMs);

            const fetched = await fetchProof(ctx, {
                capability: parsed.capability,
                block_index: blockIndex,
                pubkeys,
            });
            if (fetched.retryAfterMs !== undefined) {
                budget.pauseFor(fetched.retryAfterMs);
                return rateLimited(res, fetched.retryAfterMs / 1000);
            }
            const proof = fetched.proof;
            if (proof === null) return res.status(503).json({ error: 'PROOF_UNAVAILABLE' });
            return res.status(200).json(checkpointBody(
                parsed.snapshotBlock, parsed.capability, checkpoint, proof));
        } catch (error) {
            return res.status(503).json({ error: 'PROOF_UNAVAILABLE' });
        }
    });
}

module.exports = { mountCapabilitySnapshotProof };
