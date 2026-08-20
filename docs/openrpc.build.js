#!/usr/bin/env node
/*
 * Copyright © 2025–2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Licensed under the GNU Affero GPL v3.0 or later; see LICENSE.md.
 * A commercial license is available - contact legal@dankest.llc.
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

// The getpricesnapshots result is the one shape a downstream consumer reads
// structurally rather than by name: the dashboard's oracle-feed panel asks for
// with_watermark to get row age in the hub's clock domain, so the handler's
// return type switches from a bare array to { watermark, snapshots }. Declared
// by hand because that switch is conditional and cannot be inferred (item
// #4481); the drift guard in test/unit/openrpc-coverage.test.js keeps the
// PARAMS honest, not the result shapes.
const SNAPSHOTS_ARRAY = {
    type: 'array',
    items: {
        type: 'object',
        properties: {
            round_number:    { type: 'number' },
            coin_pair:       { type: 'string' },
            price:           { type: ['string', 'null'] },
            reference_block: { type: 'number' },
            reference_chain: { type: ['string', 'null'] },
            block_timestamp: { type: 'number' },
            validator_count: { type: 'number' },
            consensus_round: { type: 'number' },
            status:          { type: 'string', enum: ['finalized', 'skipped', 'disputed'] },
        },
    },
};
// The third branch is not decoration: express-json-rpc-router puts a handler's
// return value into `result` verbatim (node_modules/express-json-rpc-router/
// index.js:51,58), and this handler returns {error} for a bad limit or status
// rather than raising a JSON-RPC error, so a two-branch oneOf would make a
// contract-driven client reject a well-formed hub response. Same falsehood class
// the item is about, one level down.
const RPC_ERROR_ENVELOPE = {
    type: 'object',
    description: 'In-result error envelope: this handler validates arguments itself and returns {error} rather than raising a JSON-RPC error.',
    properties: { error: { type: 'string' } },
    required: ['error'],
};
const SNAPSHOTS_RESULT = {
    oneOf: [
        SNAPSHOTS_ARRAY,
        {
            type: 'object',
            description: 'Returned when with_watermark is truthy: hub-clock epoch seconds plus the rows.',
            properties: { watermark: { type: 'number' }, snapshots: SNAPSHOTS_ARRAY },
            required: ['watermark', 'snapshots'],
        },
        RPC_ERROR_ENVELOPE,
    ],
};

// ping's result is fully determined by its two returns (src/api.js:427-437), so
// it is declared rather than left unspecified. It is also the worked example the
// narrowed drift guard needs: a hand-declared object schema is admitted, while
// the blanket `type: object` it replaces is not (item #4481).
const PING_RESULT = {
    type: 'object',
    description: 'status is "degraded", with HTTP 503, when the DB probe fails or times out.',
    properties: {
        status: { type: 'string', enum: ['success', 'degraded'] },
        db:     { type: 'boolean' },
    },
    required: ['status', 'db'],
};

// name, summary, params (by-name, summary-level), tags
// auth: true ⇒ in WRITE_METHODS (x-api-key header required when HUB_API_KEY is configured)
// internal: true ⇒ used by platform services (indexers/validators), not for general clients
// result: optional JSON Schema for the return value; omitted ⇒ unconstrained
//
// Params mirror each handler's destructured argument names in src/api.js EXACTLY
// (item #4481): 20 of these rows once listed a synthetic envelope name, or none
// at all, for handlers that take real named fields, so a contract-driven client
// could not see the arguments it had to send and a rename went undetected. The
// param-fidelity assertion in test/unit/openrpc-coverage.test.js now fails on
// any re-divergence.
const METHODS = [
    ['ping', 'Health check.', [], { result: PING_RESULT }],
    ['health', 'Detailed health: DB, oracle staleness, P2P state (503 when degraded).', []],
    ['getallconfigs', 'Service discovery: connection parameters for every platform service on this chain (mesh-internal: includes DB credentials, keyed like a write). since_updated_at returns only entries changed after that timestamp.', ['since_updated_at'], { auth: true }],
    ['updateconfig', 'Update a service config entry (PBFT-replicated in validator mode).', ['config'], { auth: true }],
    ['getoraclesubmissions', 'Raw per-validator oracle price submissions for recent rounds, plus round cadence, skipped/dropped-pair diagnostics and oracleMaxPriceAgeSeconds (the price-age bound getprice enforces).', []],
    ['getpricesnapshots', 'PBFT-finalized price snapshots (trimmed-median rounds). status=\'all\' also returns skipped/disputed rows; with_watermark wraps the rows as {watermark, snapshots} with a hub-clock epoch-seconds watermark.', ['limit', 'status', 'with_watermark'], { result: SNAPSHOTS_RESULT }],
    ['getprice', 'Latest finalized price for a pair (e.g. BTC/USD).', ['coin_pair']],
    ['getfeequote', 'Protocol fee quote for an action (native-coin USD-pegged fees).', ['action', 'chain']],
    ['getcapabilitythresholds', 'Governance-set minimum stake per capability (price, cross_chain, oracle_publish, attestation).', []],
    ['registervalidator', 'Register a validator with the federation.', ['signing_pubkey', 'addr'], { auth: true }],
    ['rotatevalidator', 'Rotate a validator\'s signing key (consensus-effective at the next block boundary).', ['addr', 'new_signing_pubkey'], { auth: true }],
    ['deregistervalidator', 'Deregister a validator from the federation.', ['signing_pubkey', 'addr'], { auth: true }],
    ['syncvalidators', 'Sync the validator set from a peer.', ['validators'], { auth: true, internal: true }],
    ['getvalidators', 'Known validators and their status.', []],
    ['getvalidatorstatus', 'Status of one validator, by signing key.', ['signing_pubkey']],
    ['getattestationstats', 'Attestation throughput counters per validator.', []],
    ['getcrosschaincallstats', 'Cross-chain call relay backlog depth and lifetime failure counters.', []],
    ['getcrosschaincall', 'One XCALL relay lifecycle by call_id: {call_id, dispatch, result} (both phases from the hub\'s cross_chain_calls table).', ['call_id']],
    ['getxcall', 'One XCALL relay lifecycle by call_id (shorter alias of getcrosschaincall).', ['call_id']],
    ['listxcall', 'List XCALL relay rows, newest first, with optional source_chain/target_chain/status/phase filters.', ['source_chain', 'target_chain', 'status', 'phase', 'limit']],
    ['getcheckpointstats', 'State-checkpoint health: last finalized block per chain and quorum-timeout counters.', []],
    ['anchorflush', 'Trigger an immediate ANCHOR checkpoint publish (election still applies).', [], { auth: true }],
    ['getanchorstatus', 'ANCHOR publisher status: cumulative publish counts plus the last-observed DOGE publisher wallet balance and low-balance threshold.', []],
    ['getoraclepublisherstatus', 'ORACLE (PRICE v0) publisher status: queue depth, lifetime published/abandoned (dead-letter) counts, last-published round + txid, and the last-observed DOGE publisher wallet balance for runway monitoring.', []],
    ['geteffectorspendstatus', 'Effector-spend policy status: each on-chain effector (oracle-publish, attest, anchor, full-node) with its runtime pause state, balance floor, and rolling per-window spend ceiling clamped at the $2000 AML admission ceiling.', []],
    ['pauseeffectorspend', 'Runtime pause of one effector\'s on-chain spend by capability label (halts its primary/leader path immediately, no restart).', ['label', 'reason'], { auth: true }],
    ['resumeeffectorspend', 'Resume a paused effector\'s on-chain spend by capability label.', ['label'], { auth: true }],
    ['propose', 'Submit a governance proposal over one parameter.', ['parameter', 'current_value', 'proposed_value', 'rationale'], { auth: true }],
    ['proposeslashpenalty', 'Create a SLASH_PENALTY governance proposal over a validator\'s pending slash_proposals evidence; a passed vote executes the penalty (suspend or dismiss).', ['validator_pubkey', 'penalty', 'rationale'], { auth: true }],
    ['getslashproposals', 'List recorded slash proposals (all statuses), optionally filtered by status and/or validator pubkey. Rows with status "pending" are UNADJUDICATED accusations recorded as evidence, not findings of guilt; enforcement happens only through a passed SLASH_PENALTY governance vote. The verbatim evidence blob is never served: each row carries evidence_hash, the SHA-256 of the stored evidence text, which is the same digest the SLASH_PENALTY evidence hash is built from.', ['status', 'validator_pubkey', 'limit']],
    ['vote', 'Vote on a governance proposal.', ['proposal_id', 'vote'], { auth: true }],
    ['getproposals', 'List governance proposals, optionally filtered by status and/or parameter name.', ['status', 'parameter', 'limit']],
    ['getproposal', 'One governance proposal with votes.', ['proposal_id']],
    ['getvotes', 'List individual governance votes by proposal and/or voter.', ['proposal_id', 'voter_pubkey', 'limit']],
    ['getvalidatorcapabilities', 'Per-validator capability qualification rows (qualified, self-test, enabled flags).', ['signing_pubkey', 'capability', 'limit']],
    ['requestattestation', 'Request a cross-chain attestation for a source-chain action.', ['source_chain', 'source_action_index', 'dest_chain'], { auth: true }],
    ['getattestations', 'List cross-chain attestations, optionally filtered by status.', ['status', 'limit']],
    ['getattestation', 'One cross-chain attestation, keyed by source chain + action index.', ['source_chain', 'source_action_index']],
    ['reportreorg', 'Report a chain reorg to the federation.', ['chain', 'reorg_height', 'timestamp', 'old_hash', 'new_hash'], { auth: true }],
    ['getreorghistory', 'Recent reorg attestations.', ['limit']],
    ['initiateswap', 'Initiate a tracked cross-chain swap.', ['source_chain', 'source_action_index', 'dest_chain', 'dest_action_index'], { auth: true }],
    ['getswap', 'One tracked swap, keyed by source chain + action index.', ['source_chain', 'source_action_index']],
    ['getswaps', 'List tracked swaps, optionally filtered by status.', ['status', 'limit']],
    ['pushchaintip', 'Indexer push: chain tip update.', ['coin', 'network', 'block_height', 'block_time'], { auth: true, internal: true }],
    ['pushpriceround', 'Indexer push: finalized price round for cross-validation.', ['source_chain', 'round', 'timestamp', 'btc_block_height', 'pairs', 'sigs', 'action_index', 'block_index', 'push_generation'], { auth: true, internal: true }],
    ['pushoracleprice', 'Indexer push: user-published PRICE v1 oracle row.', ['source_chain', 'source_address', 'coin', 'tick', 'fiat', 'value', 'fee', 'memo', 'block_time', 'action_index', 'push_generation'], { auth: true, internal: true }],
    ['pushpricereorg', 'Indexer push: price reorg rollback.', ['source_chain', 'from_action_index', 'to_action_index', 'retraction_generation'], { auth: true, internal: true }],
    ['pushxcallreorg', 'Indexer push: cross-chain call reorg rollback.', ['source_chain', 'from_action_index', 'to_action_index', 'retraction_generation'], { auth: true, internal: true }],
    ['pushdexreorg', 'Indexer push: cross-chain DEX match reorg rollback.', ['source_chain', 'from_action_index', 'to_action_index', 'retraction_generation'], { auth: true, internal: true }],
];

const spec = {
    openrpc: '1.3.2',
    info: {
        title: 'XChain Hub API',
        version: '1.0.0',
        description: 'JSON-RPC 2.0 API (POST /) of the XChain hub: config oracle, price oracle, '
            + 'cross-chain coordinator, and validator-federation surface. Public deployment is '
            + 'path-routed per chain: https://hub.xchain.io/{COIN}/. Read methods are open; methods '
            + 'marked with x-auth require an x-api-key header when the operator has configured '
            + 'HUB_API_KEY. Methods marked x-internal are service-to-service (indexers/validators); '
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
            // Unconstrained unless the row declares a result schema (item #4481).
            // Every method used to claim `type: object`, which is a FALSE claim for
            // the array returners (getpricesnapshots, getvalidators, getproposals,
            // getswaps, ...): a contract-driven client validating against it rejects
            // a well-formed response. An empty schema says "unspecified", which is
            // true for every method, so declared shapes can be added one at a time
            // without the contract asserting anything wrong in the meantime, which
            // the guard permits: it rejects an object schema that describes no
            // properties, not the act of declaring an object result.
            result: { name: 'result', schema: (flags && flags.result) || {} },
        };
        if (flags && flags.auth) m['x-auth'] = 'x-api-key header, when HUB_API_KEY is configured';
        if (flags && flags.internal) m['x-internal'] = true;
        return m;
    }),
};

const out = path.join(__dirname, 'openrpc.json');
fs.writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');
console.log(`wrote ${out}: ${spec.methods.length} methods (${spec.methods.filter((m) => m['x-auth']).length} write/auth)`);
