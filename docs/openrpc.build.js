#!/usr/bin/env node
/*
 * Copyright © 2025–2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Licensed under the GNU Affero GPL v3.0 or later; see LICENSE.md.
 * A commercial license is available — contact legal@dankest.llc.
 *
 * Generates docs/openrpc.json (OpenRPC 1.3.2) for the hub's JSON-RPC API.
 * METHODS below mirrors the jsonRpcController in src/api.js (and the `auth`
 * flags mirror its WRITE_METHODS set); test/unit/openrpc-coverage.test.js
 * fails if either drifts.
 *
 * Run: node docs/openrpc.build.js
 */
const fs = require('fs');
const path = require('path');

// name, summary, params (by-name, summary-level), tags
// auth: true ⇒ in WRITE_METHODS (x-api-key header required when HUB_API_KEY is configured)
// internal: true ⇒ used by platform services (indexers/validators), not for general clients
const METHODS = [
    ['ping', 'Health check.', []],
    ['health', 'Detailed health: DB, oracle staleness, P2P state (503 when degraded).', []],
    ['getallconfigs', 'Service discovery — connection parameters for every platform service on this chain.', []],
    ['updateconfig', 'Update a service config entry (PBFT-replicated in validator mode).', ['config'], { auth: true }],
    ['getoraclesubmissions', 'Raw per-validator oracle price submissions for recent rounds.', []],
    ['getpricesnapshots', 'PBFT-finalized price snapshots (trimmed-median rounds).', ['limit']],
    ['getprice', 'Latest finalized price for a pair (e.g. BTC/USD).', ['coin_pair']],
    ['getfeequote', 'Protocol fee quote for an action (native-coin USD-pegged fees).', []],
    ['getcapabilitythresholds', 'Governance-set minimum stake per capability (price, cross_chain, oracle_publish, attestation).', []],
    ['registervalidator', 'Register a validator with the federation.', ['validator'], { auth: true }],
    ['rotatevalidator', 'Rotate a validator\'s signing key (consensus-effective at the next block boundary).', ['addr', 'new_signing_pubkey'], { auth: true }],
    ['deregistervalidator', 'Deregister a validator from the federation.', ['signing_pubkey', 'addr'], { auth: true }],
    ['syncvalidators', 'Sync the validator set from a peer.', [], { auth: true, internal: true }],
    ['getvalidators', 'Known validators and their status.', []],
    ['getvalidatorstatus', 'Status of one validator.', []],
    ['getattestationstats', 'Attestation throughput counters per validator.', []],
    ['anchorflush', 'Trigger an immediate ANCHOR checkpoint publish (election still applies).', [], { auth: true }],
    ['propose', 'Submit a governance proposal.', ['proposal'], { auth: true }],
    ['vote', 'Vote on a governance proposal.', ['proposal_id', 'vote'], { auth: true }],
    ['getproposals', 'List governance proposals.', []],
    ['getproposal', 'One governance proposal with votes.', ['proposal_id']],
    ['requestattestation', 'Request a cross-chain attestation for an action.', ['attestation'], { auth: true }],
    ['getattestations', 'List cross-chain attestations.', []],
    ['getattestation', 'One cross-chain attestation.', ['attestation_id']],
    ['reportreorg', 'Report a chain reorg to the federation.', ['reorg'], { auth: true }],
    ['getreorghistory', 'Recent reorg attestations.', []],
    ['initiateswap', 'Initiate a tracked cross-chain swap.', ['swap'], { auth: true }],
    ['getswap', 'One tracked swap.', ['swap_id']],
    ['getswaps', 'List tracked swaps.', []],
    ['pushchaintip', 'Indexer push: chain tip update.', ['coin', 'network', 'block_height', 'block_time'], { auth: true, internal: true }],
    ['pushpriceround', 'Indexer push: finalized price round for cross-validation.', [], { auth: true, internal: true }],
    ['pushoracleprice', 'Indexer push: user-published PRICE v1 oracle row.', [], { auth: true, internal: true }],
    ['pushpricereorg', 'Indexer push: price reorg rollback.', [], { auth: true, internal: true }],
    ['pushxcallreorg', 'Indexer push: cross-chain call reorg rollback.', ['source_chain', 'from_action_index'], { auth: true, internal: true }],
];

const spec = {
    openrpc: '1.3.2',
    info: {
        title: 'XChain Hub API',
        version: '1.0.0',
        description: 'JSON-RPC 2.0 API (POST /) of the XChain hub — config oracle, price oracle, '
            + 'cross-chain coordinator, and validator-federation surface. Public deployment is '
            + 'path-routed per chain: https://hub.xchain.io/{COIN}/. Read methods are open; methods '
            + 'marked with x-auth require an x-api-key header when the operator has configured '
            + 'HUB_API_KEY. Methods marked x-internal are service-to-service (indexers/validators) — '
            + 'general clients should not call them. Errors follow JSON-RPC 2.0 ({code, message}); '
            + 'registry: https://docs.xchain.io/protocol/Error_Codes.md. '
            + 'LLM-friendly docs: https://docs.xchain.io/llms.txt',
        license: { name: 'AGPL-3.0-or-later', url: 'https://docs.xchain.io/legal/LICENSING.md' },
    },
    servers: [{ name: 'public', url: 'https://hub.xchain.io/{COIN}/', variables: { COIN: { default: 'BTC', enum: ['BTC', 'TBTC', 'LTC', 'TLTC', 'DOGE', 'TDOGE'] } } }],
    methods: METHODS.map(([name, summary, params, flags]) => {
        const m = {
            name, summary,
            paramStructure: 'by-name',
            params: (params || []).map((p) => ({ name: p, required: false, schema: { type: ['string', 'number', 'object'] } })),
            result: { name: 'result', schema: { type: 'object' } },
        };
        if (flags && flags.auth) m['x-auth'] = 'x-api-key header, when HUB_API_KEY is configured';
        if (flags && flags.internal) m['x-internal'] = true;
        return m;
    }),
};

const out = path.join(__dirname, 'openrpc.json');
fs.writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');
console.log(`wrote ${out}: ${spec.methods.length} methods (${spec.methods.filter((m) => m['x-auth']).length} write/auth)`);
