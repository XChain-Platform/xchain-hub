/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
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
 * XChain Hub - JSON-RPC system family: ping, health, configs, fee quotes and
 * capability thresholds.
 *
 * Each group factory below closes over the context object and returns its
 * methods verbatim; src/api/rpc/index.js merges every family into the one
 * controller the router dispatches on.
 *
 ********************************************************************/

const configRedaction = require('../config_redaction.js');
const { DEFAULT_ORACLE_ROUND_INTERVAL_MS } = require('../../constants');
const {
    ADMIT_COLUMN_CHAINS,
    ADMIT_MARGIN_BLOCKS,
    isMirrorAdmissionProducerActive
} = require('../../consensus/gates/mirror_admission_gate.js');
const { validateChain } = require('../validate');

function buildSystemRpc(ctx) {
    return Object.assign({}, systemReads(ctx), capabilityThresholdsRpc(ctx), configsRpc(ctx), healthRpc(ctx));
}

function systemReads(ctx) {
    const { hub, DB_PROBE_TIMEOUT_MS } = ctx;
    return {
        async ping(params, {res}) {
            try {
                await Promise.race([
                    hub.db.getDatabaseLivenessProbe(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), DB_PROBE_TIMEOUT_MS))
                ]);
                return {status: "success", db: true};
            } catch (err) {
                res.status(503);
                return {status: "degraded", db: false};
            }
        },

        async updateconfig({config}){
            try {
                hub.learnNetworkFromConfig(config);
                await hub.addParametersFromJson(config);
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "there was an error trying to update a config"};
            }
        },

        async getfeequote({action, chain}){
            if(!action) return {error: "action is required"};
            if(!chain) return {error: "chain is required"};
            let chainErr = validateChain(chain);
            if (chainErr) return chainErr;
            try {
                return await hub.getFeeQuote(action, chain);
            } catch (err) {
                return {error: "error calculating fee quote"};
            }
        },
    };
}

function capabilityThresholdsRpc(ctx) {
    const { hub } = ctx;
    return {
        // Get per-capability MIN_STAKE thresholds, read live from the
        // CapabilityRegistry (the same hot-reloaded source the hub uses to
        // decide qualification). Read-only; lets clients (e.g. the wallet
        // stake form) show which capabilities a stake amount qualifies for.
        // Capabilities are global governance config, so this is not
        // chain-scoped. `disabled` flags operator-disabled capabilities.
        async getcapabilitythresholds(){
            if(!hub.capabilityRegistry) return {error: "capability registry not active"};
            try {
                let reg = hub.capabilityRegistry;
                let thresholds = reg.getCapabilities().map((cap) => ({
                    capability: cap,
                    min_stake:  reg.getMinStake(cap),
                    disabled:   reg.isDisabledByOperator(cap)
                }));
                return {thresholds};
            } catch (err) {
                return {error: "error fetching capability thresholds"};
            }
        },
    };
}

function configsRpc(ctx) {
    const { hub, configFetchCounters, COIN_CONSENSUS_HASHES } = ctx;
    return {
        // Get all service configs, tagged with the last committed PBFT sequence
        // number and the config-table high-water mark. The response is wrapped as
        // { configs, seq, watermark } so consumers can detect a config change that
        // was committed between polls and invalidate their cache. seq is 0 on a
        // fresh node (no commits yet). Consumers that predate this wrapper read the
        // bare map; the wrapper keeps the config tree under `configs` so their
        // coin-key iteration still works once they unwrap.
        //
        // An optional `since_updated_at` param (epoch seconds, echoed from a prior
        // response's `watermark`) turns the call into a delta: only rows changed
        // since that instant are returned, so a quiet poll transfers near-nothing
        // instead of the whole table. Callers that omit it get the full tree, so
        // the change is fully backward-compatible. The watermark is read before
        // the rows, and the cursor second is INCLUSIVE on the next delta
        // (db.getAllConfigs compares `>=`), so a write racing the two reads - or
        // committed after them but stamped in the watermark's second - is
        // re-delivered, never skipped. Consumers must merge idempotently: rows in
        // the cursor second repeat on each poll until a newer write lands (#2265).
        //
        // Secret-bearing params (rpc/DB passwords) are REDACTED unless the call
        // sets `include_secrets: true`, which the auth middleware has already
        // authorized against HUB_CONFIG_SECRETS_API_KEY (or the bulk key when
        // that is unset); see the credential-tier note above. The response says
        // which it is: `secrets_redacted` is true whenever a value was withheld
        // or would have been, so a consumer that needs credentials and forgot the
        // flag can say so instead of failing later on a bad password.
        async getallconfigs(params) {
            try {
                let since       = params && params.since_updated_at;
                let wantSecrets = configRedaction.wantsSecrets(params && params.include_secrets);
                let seq         = await hub.getLastSeq();
                let watermark   = await hub.getConfigWatermark();
                let configs     = await hub.getAllConfigs(since);
                let redacted    = 0;
                if (!wantSecrets) {
                    let result = configRedaction.redactConfigTree(configs);
                    configs  = result.configs;
                    redacted = result.redacted;
                }
                configFetchCounters.served++;
                // coin_consensus_hashes is additive: consumers that predate it ignore
                // the field; new consumers cross-check it against their bundled pins.
                return {configs, seq, watermark, coin_consensus_hashes: COIN_CONSENSUS_HASHES,
                        secrets_redacted: !wantSecrets, redacted_params: redacted};
            } catch (err) {
                configFetchCounters.errors++;
                return {error: "there was an error trying to get all configs"};
            }
        },
    };
}

function healthRpc(ctx) {
    const { hub, hubConfig, p2pConfig, configFetchCounters, DB_PROBE_TIMEOUT_MS } = ctx;
    return {
        // Like ping, but also reports the DB circuit-breaker state. The breaker
        // trips open after repeated connection failures and rejects queries during
        // its cooldown; exposing it lets an operator distinguish a healthy hub from
        // one that is up but stalled waiting on a tripped database connection.
        async health(params, {res}) {
            let dbOk = await probeDatabase(hub, DB_PROBE_TIMEOUT_MS);
            let dbCircuit = hub.db ? hub.db.circuitState : null;
            let healthy = dbOk && dbCircuit !== 'open';

            // Oracle freshness. DB liveness alone can't reveal an oracle that has
            // stopped finalizing rounds (e.g. a price-feed outage), and a restart
            // wipes the in-memory skip counters; without this a probe hitting
            // /health would see a clean bill of health during a stale-feed window.
            // Surface the age of the most recent finalized round so probes can
            // detect staleness without the heavier diagnostics RPC. Only evaluated
            // on oracle-running (P2P-enabled) hubs; a config-only hub mints no rounds.
            let { oracleAgeS, oracleStale, oracleThresholdS } =
                await probeOracleFreshness(hub, hubConfig, dbOk, p2pConfig, DB_PROBE_TIMEOUT_MS);
            if (oracleStale) healthy = false;

            // Consensus-input reachability. The snapshot fetches that lock
            // a round's validator set fail CLOSED, so a hub that cannot reach its BTC
            // indexer stops participating in every capability / attestation /
            // config-change round while its process and port stay perfectly healthy.
            // Reporting "healthy" through that is the fail-open-observability bug the
            // 2026-06-24 review flagged, so a sustained failure streak degrades the
            // probe. A config-only hub never fetches consensus input at all (the
            // counters stay zero), so this can only fire where it means something.
            let consensusInput = (hub.capabilitySnapshot && hub.capabilitySnapshot.monitor)
                ? hub.capabilitySnapshot.monitor.snapshot() : null;
            if (consensusInput && consensusInput.alerting) healthy = false;

            // Admission-height production has a hard per-chain precondition: above
            // its activation the hub cannot finalize a mirrored row unless every
            // chain in that row's read set has a fresh decoder tip. Probe the full
            // federation set here so an operator sees the dependency before a round
            // pays for it. The resolver applies the same freshness gate as the
            // producer and returns null rather than guessing a height.
            let admissionTips = await probeAdmissionTips(hub, p2pConfig, DB_PROBE_TIMEOUT_MS);
            if (admissionTips && !admissionTips.healthy) healthy = false;

            let published = publisherStats(hub);

            if(!healthy) res.status(503);
            return healthBody(hub, configFetchCounters, published, {
                healthy, dbOk, dbCircuit, oracleAgeS, oracleStale, oracleThresholdS,
                consensusInput, admissionTips
            });
        },
    };
}

// DB liveness, bounded by the shared probe timeout.
async function probeDatabase(hub, DB_PROBE_TIMEOUT_MS) {
    let dbOk = false;
    try {
        await Promise.race([
            hub.db.getDatabaseLivenessProbe(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), DB_PROBE_TIMEOUT_MS))
        ]);
        dbOk = true;
    } catch (err) {
        dbOk = false;
    }
    return dbOk;
}

// Age of the most recent finalized round against its staleness threshold, read only
// when the DB answered and the hub runs an oracle.
async function probeOracleFreshness(hub, hubConfig, dbOk, p2pConfig, DB_PROBE_TIMEOUT_MS) {
    let oracleAgeS     = null;
    let oracleStale    = false;
    let oracleThresholdS = null;
    if (dbOk && p2pConfig) {
        try {
            let roundIntervalMs = p2pConfig.ORACLE_ROUND_INTERVAL || DEFAULT_ORACLE_ROUND_INTERVAL_MS;
            // Default to 2x the round interval; an operator can override for
            // slow-start environments via ORACLE_STALENESS_THRESHOLD_S.
            oracleThresholdS = parseInt(hubConfig.ORACLE_STALENESS_THRESHOLD_S)
                || Math.round((roundIntervalMs * 2) / 1000);
            let rows = await Promise.race([
                hub.db.getPriceSnapshotsFinalizedAgeSeconds(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), DB_PROBE_TIMEOUT_MS))
            ]);
            // age_s is null when no round has ever finalized (fresh node);
            // treat that as not-stale so a slow first round doesn't 503.
            if (rows && rows.length && rows[0].age_s != null) {
                oracleAgeS  = Number(rows[0].age_s);
                oracleStale = oracleAgeS > oracleThresholdS;
            }
        } catch (err) {
            // Non-fatal: DB health is still reported if the oracle probe fails
        }
    }
    return { oracleAgeS, oracleStale, oracleThresholdS };
}

// The same per-chain read the producer uses, bounded so /health cannot hang behind
// an indexer. A stale resolver result is null; the last observation is retained only
// as diagnosis and is never promoted back into a usable admission height.
async function probeAdmissionTips(hub, p2pConfig, timeoutMs) {
    if (!p2pConfig || !hub || typeof hub.resolveAdmissionTips !== 'function') return null;

    let resolved = {};
    try {
        resolved = await Promise.race([
            hub.resolveAdmissionTips(ADMIT_COLUMN_CHAINS.slice()),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
        ]) || {};
    } catch (_) {
        resolved = {};
    }

    let chains = {};
    let missing = [];
    for (let chain of ADMIT_COLUMN_CHAINS) {
        let tip = usableAdmissionHeight(resolved[chain]);
        let previous = lastAdmissionTip(hub, chain);
        let stale = false;
        if (tip === null && previous !== null) {
            stale = typeof hub.admissionTipFresh === 'function'
                ? !hub.admissionTipFresh(chain, previous.height)
                : true;
        }
        if (tip === null) missing.push(chain);
        chains[chain] = {
            height: tip === null && previous !== null ? previous.height : tip,
            observed_at_ms: previous === null ? null : previous.at_ms,
            age_s: previous === null || previous.at_ms === null
                ? null : Math.max(0, Math.floor((Date.now() - previous.at_ms) / 1000)),
            fresh: tip !== null,
            stale,
            reason: tip !== null ? null : (stale
                ? 'admission tip for ' + chain + ' is stale'
                : 'no fresh admission tip for ' + chain)
        };
    }

    // Signed admission rows use their own BTC anchor for the producer flag day.
    // A stale last observation is sufficient to establish that the node has crossed
    // the activation, but is diagnostic only and remains unusable above.
    let btcHeight = chains.BTC && chains.BTC.height;
    let producerActive = usableAdmissionHeight(btcHeight) !== null &&
        isMirrorAdmissionProducerActive('BTC', hub.network, btcHeight);
    return {
        producer_active: producerActive,
        healthy: !producerActive || missing.length === 0,
        reason: producerActive && missing.length > 0
            ? 'no fresh admission tip for ' + missing.join(', ') + '; refusing to finalize admission-era rows'
            : null,
        admit_margin_blocks: ADMIT_MARGIN_BLOCKS,
        chains
    };
}

function usableAdmissionHeight(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function lastAdmissionTip(hub, chain) {
    let seen = hub && hub._admissionTipSeen;
    if (!seen || typeof seen.get !== 'function') return null;
    let value = seen.get(chain);
    if (!value) return null;
    let height = usableAdmissionHeight(value.height);
    return height === null ? null : { height, at_ms: Number(value.atMs) || null };
}

// The anchor, attestation and relay stats, read before the status code is set.
function publisherStats(hub) {
    let anchorStats = hub.stateAnchorPublisher ? hub.stateAnchorPublisher.getAnchorStats() : null;
    let attestStats = hub.attestationPublisher ? hub.attestationPublisher.getPublisherStats() : null;
    // Attestation relay. The relay drives the v3 request /v4 response
    // legs across chains and until now its only instrument was the process log,
    // so an operator could not see that a finalized v4 was sitting held for want
    // of an origin-chain broadcast rail. The typeof guard is for a hub built
    // before the relay carried getStats(), matching hub_db_stream below.
    let relayStats = (hub.attestationRelay && typeof hub.attestationRelay.getStats === 'function')
        ? hub.attestationRelay.getStats() : null;
    return { anchorStats, attestStats, relayStats };
}

// The /health response body; every section past config_fetch is telemetry only.
function healthBody(hub, configFetchCounters, { anchorStats, attestStats, relayStats },
                    { healthy, dbOk, dbCircuit, oracleAgeS, oracleStale, oracleThresholdS,
                      consensusInput, admissionTips }) {
    let healthResult = {
        status:    healthy ? "healthy" : "degraded",
        db:        dbOk,
        dbCircuit: dbCircuit,
        oracle_last_finalized_age_s:  oracleAgeS,
        oracle_stale:                 oracleStale,
        oracle_staleness_threshold_s: oracleThresholdS,
        config_fetch: {
            served: configFetchCounters.served,
            errors: configFetchCounters.errors
        }
    };
    if (consensusInput) healthResult.consensus_input = consensusInput;
    if (admissionTips) healthResult.admission_tips = admissionTips;
    if (anchorStats) healthResult.anchor = anchorStats;
    if (attestStats) healthResult.attest = attestStats;
    // Telemetry only, never a 503: a relay that is disabled, or holding
    // responses for an unconfigured origin chain, is a configuration fact
    // rather than a sick hub, and 503-ing the config oracle over it would
    // take the federation's config rail down with it.
    if (relayStats) healthResult.attest_relay = relayStats;
    // Operator stake share vs the STAKE_WEIGHTED_QUORUM commit gate.
    // Telemetry only, never a 503, for the same reason as the relay above and a
    // stronger one: this is a forecast about the FEDERATION's stake distribution,
    // not a sickness of this process. No restart fixes it, and 503-ing every hub
    // over it would take the config rail down alongside the price rail it warns
    // about. The alert channel is the loud log, the `alerting` flag here, and the
    // xchain_stake_share_* gauges built from the same numbers.
    if (hub.stakeShareWatcher && typeof hub.stakeShareWatcher.getStats === 'function')
        healthResult.stake_share = hub.stakeShareWatcher.getStats();
    // Hub DB stream heartbeat. Consumers gate their price-sync
    // barriers on this watermark, and until now the cadence was only ever
    // visible from the consumer's own timeout logs. Body-only telemetry,
    // like config_fetch above: a stalled heartbeat is worth alerting on but
    // is not by itself a reason to 503 a hub whose DB and oracle are fine.
    if (hub.hubDbBroadcaster && typeof hub.hubDbBroadcaster.getWatermarkStats === 'function')
        healthResult.hub_db_stream = hub.hubDbBroadcaster.getWatermarkStats();
    return healthResult;
}

module.exports = { buildSystemRpc };
