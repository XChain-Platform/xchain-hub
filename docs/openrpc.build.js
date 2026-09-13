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
            description: 'Returned when with_watermark is truthy: hub-clock epoch seconds, the price-age bound getprice enforces (oracleMaxPriceAgeSeconds, null when the registry read fails), plus the rows.',
            properties: { watermark: { type: 'number' }, oracleMaxPriceAgeSeconds: { type: ['number', 'null'] }, snapshots: SNAPSHOTS_ARRAY },
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

// getbridgeinvariant returns a MAP (tick -> chain -> entry, the BridgeInvariant
// typedef in src/api.js), which is the second shape a downstream consumer reads
// structurally rather than by name: the explorer token page, the wallet move flow
// and the platform watch script all key into it. Declared by hand for the
// same reason SNAPSHOTS_RESULT is, and with the same {error} branch, because the
// handler answers a bad tick or an inactive engine in its own result rather than
// raising a JSON-RPC error. Every property is always present on an entry
// (CrossChainBridgeEngine.getBridgeInvariant seeds each one), but escrow, supply
// and delta are null until the chain state is readable, which is why their types
// carry 'null': a chain the hub cannot read reports "unknown", never a fabricated
// zero, since a zero on a live copy reads as a total deficit.
const BRIDGE_INVARIANT_ENTRY = {
    type: 'object',
    description: 'Backing of one tick on one chain. escrow is the balance at ADDRESS.BRIDGE_<chain> on the tick\'s ORIGIN chain; delta is the signed escrow - (supply + in_flight), positive a surplus (WARN: a stranger may SEND to an escrow, which is their own loss), negative a deficit (CRIT: someone else\'s units are unbacked). Null escrow/supply/delta mean the chain state was not readable, not zero. The origin chain holds the asset itself, so it carries no escrow and no delta.',
    properties: {
        escrow:               { type: ['string', 'null'] },
        supply:               { type: ['string', 'null'] },
        in_flight:            { type: 'string' },
        delta:                { type: ['string', 'null'] },
        finalized_policy_seq: { type: ['number', 'null'] },
    },
    required: ['escrow', 'supply', 'in_flight', 'delta', 'finalized_policy_seq'],
};
const BRIDGE_INVARIANT_RESULT = {
    oneOf: [
        {
            type: 'object',
            description: 'tick -> chain -> entry. XCHAIN is always present, so the base asset can be read on a chain that has carried no token leg; `tick` narrows the map to that one tick.',
            additionalProperties: {
                type: 'object',
                description: 'chain -> entry, one entry per chain this tick has a leg on.',
                additionalProperties: BRIDGE_INVARIANT_ENTRY,
            },
        },
        RPC_ERROR_ENVELOPE,
    ],
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
    ['getallconfigs', 'Service discovery: connection parameters for every platform service on this chain (mesh-internal, keyed like a write). Secret-bearing params (rpc/DB passwords) are REDACTED to the literal "[redacted]" unless include_secrets is set, which needs HUB_CONFIG_SECRETS_API_KEY when the hub configures one and the bulk key otherwise; the response reports secrets_redacted and redacted_params. since_updated_at returns only entries changed after that timestamp.', ['since_updated_at', 'include_secrets'], { auth: true }],
    ['updateconfig', 'Update a service config entry (PBFT-replicated in validator mode).', ['config'], { auth: true }],
    ['getoraclesubmissions', 'Raw per-validator oracle price submissions for recent rounds, plus round cadence, skipped/dropped-pair diagnostics and oracleMaxPriceAgeSeconds (the price-age bound getprice enforces). Carries active:true; a hub that runs no oracle round (standalone config-oracle deployment, no P2P_VALIDATOR_ADDR) answers {active:false} rather than an error, so a health consumer can tell an absent role from a failure.', []],
    ['getpricesnapshots', 'PBFT-finalized price snapshots (trimmed-median rounds). status=\'all\' also returns skipped/disputed rows; with_watermark wraps the rows as {watermark, oracleMaxPriceAgeSeconds, snapshots} with a hub-clock epoch-seconds watermark and the price-age bound getprice enforces.', ['limit', 'status', 'with_watermark'], { result: SNAPSHOTS_RESULT }],
    ['getoracleroundpresence', 'Per-round oracle PRESENCE over a range: for every round in [from_round, to_round], whether this hub recorded it at all and how it ended (finalized / skipped / disputed / missing), plus the explicit `missing` list and a `digest` over the (round, status) sequence. Poll several hubs over the same range and compare digests to detect federation divergence about which rounds happened. Omitted bounds anchor on this hub\'s highest recorded round and the last `limit` rounds (default 50, max 1000).', ['from_round', 'to_round', 'limit']],
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
    ['getstakeshare', 'Operator stake share against the STAKE_WEIGHTED_QUORUM commit gate, per chain and capability: total active stake, our share of it, whether it clears 3*tally > 2*S, and how much further third-party stake fits before it stops clearing.', []],
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
    // Present in the committed spec but missing from this list, so a regeneration
    // silently deleted them and only the drift guard (spec methods === controller
    // methods) noticed. Restored verbatim from the committed spec, for the same
    // reason pushpricebatch below was: this generator has to be idempotent.
    ['getattestationresponsibleset', 'The responsible validator set for one pending attestation request, resolved from the capability snapshot at its buried block.', [{ name: 'request_id', required: true, schema: { type: 'string' } }]],
    ['getrollcallstatus', "ROLLCALL presence-proof publisher status for this hub: the epoch it last worked, whether it signed, how many signatures it holds and how many are already on chain, the elected leader and this hub's rank, any txids it published, and whether its signer module can broadcast. Publisher state only: the authoritative roll-call record lives on the BTC indexer.", [], { auth: true }],
    ['reportreorg', 'Report a chain reorg to the federation.', ['chain', 'reorg_height', 'timestamp', 'old_hash', 'new_hash'], { auth: true }],
    ['getreorghistory', 'Recent reorg attestations.', ['limit']],
    ['initiateswap', 'Initiate a tracked cross-chain swap.', ['source_chain', 'source_action_index', 'dest_chain', 'dest_action_index'], { auth: true }],
    ['getswap', 'One tracked swap, keyed by source chain + action index.', ['source_chain', 'source_action_index']],
    ['getswaps', 'List tracked swaps, optionally filtered by status.', ['status', 'limit']],
    ['getbridgeinvariant', 'Bridge backing invariant, tick -> chain -> {escrow, supply, in_flight, delta, finalized_policy_seq}: the escrow held at ADDRESS.BRIDGE_<chain> on the tick\'s origin chain against that chain\'s supply plus in-flight transfers. Open read tier on purpose (no x-auth): the explorer token page, the wallet move flow and the operator watch item all read it without a federation key. `tick` narrows the map to one tick; without it XCHAIN is always present. The invariant is an INEQUALITY (escrow >= supply + in_flight), so a positive delta is a surplus and only a negative delta is a deficit.', ['tick'], { result: BRIDGE_INVARIANT_RESULT }],
    ['pushchaintip', 'Indexer push: chain tip update.', ['coin', 'network', 'block_height', 'block_time', 'chain_id'], { auth: true, internal: true }],
    ['pushpriceround', 'Indexer push: finalized price round for cross-validation.', ['source_chain', 'round', 'timestamp', 'btc_block_height', 'pairs', 'sigs', 'action_index', 'block_index', 'push_generation', 'admit_blocks'], { auth: true, internal: true }],
    // Present in the committed spec but missing from this list, so every
    // regeneration silently DELETED it and the drift guard only noticed on the
    // next run. Restored here so `node docs/openrpc.build.js` is idempotent.
    ['pushpricebatch', 'Indexer push: a finalized PRICE v2 batch, carrying every round in one window under one signature set.', ['source_chain', 'first_round', 'last_round', 'btc_block_height', 'rounds', 'block_time', 'sigs', 'action_index', 'block_index', 'push_generation'], { auth: true, internal: true }],
    ['pushattestbatch', 'Indexer push: an ATTEST v5 response batch parsed off the DOGE rail, carrying every terminal response of one window under one signature set.', ['source_chain', 'network', 'window_start', 'window_end', 'row_count', 'btc_block_height', 'rows', 'sigs', 'action_index', 'block_index', 'block_time', 'push_generation'], { auth: true, internal: true }],
    ['pushoracleprice', 'Indexer push: user-published PRICE v1 oracle row.', ['source_chain', 'source_address', 'coin', 'tick', 'fiat', 'value', 'fee', 'memo', 'block_time', 'action_index', 'push_generation'], { auth: true, internal: true }],
    ['pushpricereorg', 'Indexer push: price reorg rollback.', ['source_chain', 'from_action_index', 'to_action_index', 'retraction_generation'], { auth: true, internal: true }],
    ['pushxcallreorg', 'Indexer push: cross-chain call reorg rollback.', ['source_chain', 'from_action_index', 'to_action_index', 'retraction_generation'], { auth: true, internal: true }],
    ['pushdexreorg', 'Indexer push: cross-chain DEX match reorg rollback.', ['source_chain', 'from_action_index', 'to_action_index', 'retraction_generation'], { auth: true, internal: true }],
    ['pushbridgereorg', 'Indexer push: XBRIDGE lock/burn reorg rollback. Every bridge_transfers record whose SOURCE leg sits at or above from_action_index is marked retracted and its deletion broadcast so mirrors drop the row. A destination leg already applied stays applied (milestone 1 ships no destination-side unwind), so getbridgeinvariant then reports the deficit; policy_snapshots has no retraction path, being append-only.', ['source_chain', 'from_action_index', 'to_action_index', 'retraction_generation'], { auth: true, internal: true }],
    ['retractattestbatch', 'Indexer push: a reorg un-landed an ATTEST v5 batch, so the batch link it stamped on the carried response rows is cleared. Clears the link only; no mirror row is deleted.', ['source_chain', 'network', 'batch_key', 'window_start', 'window_end', 'action_index'], { auth: true, internal: true }],
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
            // A param is either a bare name (the summary-level default: optional, and
            // unconstrained across the three shapes JSON-RPC by-name arguments arrive
            // in) or a declared {name, required, schema}. The declared form exists
            // because the committed spec already carried hand-tightened params that a
            // regeneration would otherwise have silently loosened, which is the same
            // idempotency failure the restored rows above document from the other side.
            params: (params || []).map((p) => (typeof p === 'string'
                ? { name: p, required: false, schema: { type: ['string', 'number', 'object'] } }
                : { name: p.name, required: p.required === true,
                    schema: p.schema || { type: ['string', 'number', 'object'] } })),
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
