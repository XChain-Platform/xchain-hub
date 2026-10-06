'use strict';

const http = require('http');
const https = require('https');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const registry = require('./catchup_verifiers.js');
const { createCatchupState } = require('./catchup_state.js');

const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_WARN_INTERVAL_MS = 60000;
const DEFAULT_RETRY_INTERVAL_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

function peerFeedUrl(peerAddr, table, cursor, limit) {
    let value = String(peerAddr || '');
    if (!/^[a-z]+:\/\//i.test(value)) value = 'ws://' + value;
    const url = new URL(value);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    else if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Unsupported peer URL protocol: ' + url.protocol);
    }
    url.pathname = '/hub-db/snapshot/' + table;
    url.search = '';
    url.searchParams.set('since_id', String(cursor));
    url.searchParams.set('limit', String(limit));
    return url;
}

function requestJson(url, feedKey, timeoutMs) {
    return new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const headers = feedKey ? { 'x-api-key': feedKey } : {};
        const req = transport.request(url, { method: 'GET', headers }, (res) => {
            let size = 0;
            const chunks = [];
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > MAX_RESPONSE_BYTES) {
                    req.destroy(new Error('Hub DB catch-up response exceeded byte limit'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error('Snapshot request returned HTTP ' + res.statusCode));
                    return;
                }
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error('Snapshot response was not valid JSON')); }
            });
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error('Snapshot request timed out')));
        req.on('error', reject);
        req.end();
    });
}

function connectedSignerPeers(peerManager) {
    if (!peerManager || !peerManager.peers || !peerManager.validatorPubkeys) return [];
    const signerSet = peerManager.effectiveSignerSet;
    const peers = [];
    for (const [addr, peer] of peerManager.peers) {
        if (!peer || (peer.state !== 'open' && peer.state !== 'connected')) continue;
        const identity = peer.validatorAddr || addr;
        const pubkey = peerManager.validatorPubkeys.get(identity) || peer.signing_pubkey;
        if (!pubkey) continue;
        const normalizedPubkey = String(pubkey).toLowerCase();
        const inSignerSet = signerSet && signerSet.has(normalizedPubkey);
        const inRegistry = typeof peerManager.registryHasPubkey === 'function' &&
            peerManager.registryHasPubkey(normalizedPubkey);
        if (!inSignerSet && !inRegistry) continue;
        const feedUrl = peer.feedUrl ||
            (peerManager.validatorFeedUrls && peerManager.validatorFeedUrls.get(identity)) ||
            (peer.inbound ? null : addr);
        peers.push({ addr, identity, feedUrl });
    }
    return peers;
}

function verifierAccepted(verdict) {
    if (verdict === false || verdict === null) return false;
    if (verdict && typeof verdict === 'object' && verdict.ok === false) return false;
    return true;
}

function refusalReason(verdict) {
    if (verdict && typeof verdict === 'object' && verdict.reason) return String(verdict.reason);
    return 'verifier refused row';
}

function admissionBlocks(row) {
    return {
        admit_block_btc: row.admit_block_btc,
        admit_block_ltc: row.admit_block_ltc,
        admit_block_doge: row.admit_block_doge
    };
}

function withoutWireId(row) {
    return Object.fromEntries(Object.entries(row || {}).filter(([column]) => column !== 'id'));
}

async function hasRows(promise) {
    const rows = await promise;
    return Array.isArray(rows) ? rows.length > 0 : Boolean(rows);
}

const CONTENT_KEY_READERS = Object.freeze({
    price_snapshots: async (db, row) => {
        const rows = await db.findPriceSnapshotsForRound(row.round_number);
        return Array.isArray(rows) && rows.some(held => held && held.coin_pair === row.coin_pair);
    },
    oracle_prices: (db, row) => hasRows(
        db.getOraclePrice(row.source_address, row.source_chain, row.action_index)),
    cross_chain_matches: (db, row) => hasRows(db.getCrossChainMatchByMatchId(row.match_id)),
    capability_snapshots: (db, row) => hasRows(db.getCapabilitySnapshot(
        row.snapshot_block, row.capability, row.signing_pubkey, row.source)),
    cross_chain_calls: (db, row) => hasRows(
        db.getCrossChainCallByCallIdAndPhase(row.call_id, row.phase)),
    state_checkpoints: (db, row) => hasRows(
        db.getStateCheckpointByChainAndNetworkAndCheckpointSeq(
            row.chain, row.network, row.checkpoint_seq)),
    anchor_reward_attestations: (db, row) => hasRows(db.getAnchorRewardAttestation(
        row.chain, row.network, row.reward_type, row.round_reference, row.snapshot_block,
        row.publisher)),
    attestation_responses: (db, row) => hasRows(
        db.getAttestationResponse(row.network, row.request_id, row.effective_time)),
    bridge_transfers: (db, row) => hasRows(db.getBridgeTransferByTransferId(row.transfer_id)),
    policy_snapshots: (db, row) => hasRows(db.getPolicySnapshotAtSeq(
        row.network, row.origin_chain, row.tick, row.policy_seq)),
    list_snapshots: (db, row) => hasRows(db.getListSnapshotAtSeq(
        row.network, row.home_chain, row.home_list_index, row.seq))
});

async function rowAlreadyHeld(db, table, row) {
    const reader = CONTENT_KEY_READERS[table];
    if (!reader) throw new Error('No hub DB catch-up content reader for table: ' + table);
    return reader(db, row);
}

function storePriceSnapshot(db, row) {
    const pairs = [{ pair: row.coin_pair, coinPair: row.coin_pair, price: row.price }];
    if (row.status === 'skipped') {
        return db.setSkippedPriceSnapshotRound(
            row.round_number, [row.coin_pair], row.reference_block, row.block_timestamp);
    }
    const common = [row.round_number, pairs, row.reference_block, row.reference_chain,
        row.block_timestamp, row.validator_count, row.consensus_proof, row.source_action_index,
        row.push_generation, row.created_at];
    if (row.batch_block_time !== null && row.batch_block_time !== undefined) {
        common.splice(9, 0, row.batch_block_time);
        return db.setBatchPriceSnapshotRound(...common, admissionBlocks(row));
    }
    if (row.source_chain !== null && row.source_chain !== undefined) {
        return db.setPushedPriceSnapshotRound(...common, admissionBlocks(row));
    }
    return db.setFinalizedPriceSnapshotRound(row.round_number,
        [{ coinPair: row.coin_pair, price: row.price }], row.reference_block,
        row.block_timestamp, row.validator_count, row.consensus_proof, admissionBlocks(row));
}

const ROW_WRITERS = Object.freeze({
    price_snapshots: storePriceSnapshot,
    oracle_prices: (db, row) => db.setOraclePriceByGeneration(row),
    cross_chain_matches: (db, row) => db.createCrossChainMatch(row, row.btc_chain_id),
    capability_snapshots: (db, row) => db.createCapabilitySnapshots([row], row.btc_chain_id),
    cross_chain_calls: (db, row) => db.setCrossChainCallFinalized(row, row.btc_chain_id),
    state_checkpoints: (db, row) => db.createStateCheckpoint(
        row.chain, row.network, row.block_index, row.block_hash, row.ledger_hash, row.actions_hash,
        row.contract_hash, row.checkpoint_seq, row.snapshot_block, row.state_root,
        row.state_root_version, row.block_merkle_root, row.block_merkle_version,
        row.validator_signatures),
    anchor_reward_attestations: (db, row) => db.createAnchorRewardAttestation(
        row.chain, row.network, row.reward_type, row.round_reference, row.snapshot_block,
        row.publisher, row.reward_amount, row.publisher_attestations, row.doge_anchor_txid),
    attestation_responses: (db, row) => db.createAttestationResponseMirrorRow(row),
    bridge_transfers: (db, row) => db.insertBridgeTransfer(row),
    policy_snapshots: (db, row) => db.insertPolicySnapshot(row),
    list_snapshots: (db, row) => db.insertListSnapshot(row)
});

function storeVerifiedRow(db, table, row) {
    const writer = ROW_WRITERS[table];
    if (!writer) throw new Error('No hub DB catch-up writer for table: ' + table);
    return writer(db, withoutWireId(row));
}

class HubDbPeerCatchup {
    constructor(options) {
        const opts = options || {};
        this.db = opts.db;
        this.peerManager = opts.peerManager;
        this.feedKey = opts.feedKey || '';
        this.pageSize = Number(opts.pageSize) > 0 ? Number(opts.pageSize) : DEFAULT_PAGE_SIZE;
        this.warnIntervalMs = Number(opts.warnIntervalMs) > 0
            ? Number(opts.warnIntervalMs) : DEFAULT_WARN_INTERVAL_MS;
        this.retryIntervalMs = Number(opts.retryIntervalMs) > 0
            ? Number(opts.retryIntervalMs) : DEFAULT_RETRY_INTERVAL_MS;
        this.requestTimeoutMs = Number(opts.requestTimeoutMs) > 0
            ? Number(opts.requestTimeoutMs) : DEFAULT_REQUEST_TIMEOUT_MS;
        this.logger = opts.logger || getLogger();
        this.fetchPage = opts.fetchPage || ((peer, table, cursor, limit) =>
            requestJson(peerFeedUrl(peer, table, cursor, limit), this.feedKey, this.requestTimeoutMs));
        this.getVerifier = opts.getVerifier || registry.getCatchupVerifier;
        this.hasRow = opts.hasRow || ((table, row) => rowAlreadyHeld(this.db, table, row));
        this.storeRow = opts.storeRow || ((table, row) => storeVerifiedRow(this.db, table, row));
        this.tables = opts.tables || registry.MIRRORED_TABLES;
        this.state = createCatchupState(this.tables);
        // Usable peers seen by the last run. Zero means no signer-set peer this hub can
        // fetch from, so there is nothing to catch up against; the hub then serves as
        // v0.21.3 did (always caught up) rather than freezing admission for every reader.
        this.lastUsablePeerCount = 0;
        this.lastUngatedWarnAt = null;
        this.runningPromise = null;
        this.rerunRequested = false;
        this.warnTimer = null;
        this.retryTimer = null;
        this.lastNoPeerWarnAt = null;
        this.lastNoFeedUrlWarnAt = new Map();
        this.started = false;
        this.onPeerConnect = () => this.schedule();
    }

    start() {
        if (this.started) return this.runningPromise || Promise.resolve();
        this.started = true;
        if (this.peerManager && typeof this.peerManager.on === 'function') {
            this.peerManager.on('peer:connect', this.onPeerConnect);
        }
        this.warnTimer = setInterval(() => this.warnIfNoPeer(), this.warnIntervalMs);
        if (this.warnTimer.unref) this.warnTimer.unref();
        this.retryTimer = setInterval(() => {
            if (!this.allCaughtUp() && connectedSignerPeers(this.peerManager).length > 0) {
                this.schedule();
            }
        }, this.retryIntervalMs);
        if (this.retryTimer.unref) this.retryTimer.unref();
        return this.schedule();
    }

    stop() {
        if (this.warnTimer) clearInterval(this.warnTimer);
        this.warnTimer = null;
        if (this.retryTimer) clearInterval(this.retryTimer);
        this.retryTimer = null;
        if (this.peerManager && typeof this.peerManager.removeListener === 'function') {
            this.peerManager.removeListener('peer:connect', this.onPeerConnect);
        }
        this.started = false;
    }

    schedule() {
        if (this.runningPromise) {
            this.rerunRequested = true;
            return this.runningPromise;
        }
        this.runningPromise = this.run().finally(() => {
            this.runningPromise = null;
            if (this.rerunRequested) {
                this.rerunRequested = false;
                this.schedule();
            }
        });
        return this.runningPromise;
    }

    tableCaughtUp(table) {
        return this.state.isTableCaughtUp(table);
    }

    caughtUpState() {
        return this.state.status();
    }

    allCaughtUp() {
        return this.state.isCaughtUp();
    }

    isCaughtUp() {
        if (this.lastUsablePeerCount === 0) {
            this.warnIfUngated();
            return true;
        }
        return this.state.isCaughtUp();
    }

    warnIfUngated() {
        const now = Date.now();
        if (this.lastUngatedWarnAt !== null && now - this.lastUngatedWarnAt < this.warnIntervalMs) return false;
        this.lastUngatedWarnAt = now;
        this.logger.warn('Hub DB peer catch-up: no usable signer-set peer; admission is not gated on catch-up');
        return true;
    }

    async run() {
        this.state.resetAll();
        const peers = connectedSignerPeers(this.peerManager);
        if (peers.length === 0) {
            this.lastUsablePeerCount = 0;
            this.warnIfNoPeer();
            return this.caughtUpState();
        }
        const fetchablePeers = peers.filter((peer) => {
            if (peer.feedUrl) return true;
            this.warnIfNoFeedUrl(peer);
            return false;
        });
        this.lastUsablePeerCount = fetchablePeers.length;
        for (const table of this.tables) {
            const verifier = this.getVerifier(table);
            if (!verifier) continue;
            for (const peer of fetchablePeers) {
                try {
                    await this.catchUpTable(peer.feedUrl, table, verifier, peer.identity);
                    this.state.markCaughtUp(table);
                    break;
                } catch (e) {
                    this.logger.warn(nodeUtil.format('Hub DB peer catch-up failed for ' + table +
                        ' from ' + peer.feedUrl + ':', e && e.message ? e.message : e));
                }
            }
        }
        return this.caughtUpState();
    }

    warnIfNoPeer() {
        if (connectedSignerPeers(this.peerManager).length > 0) return false;
        const now = Date.now();
        if (this.lastNoPeerWarnAt !== null && now - this.lastNoPeerWarnAt < this.warnIntervalMs) return false;
        this.lastNoPeerWarnAt = now;
        this.logger.warn('Hub DB peer catch-up: no connected signer-set peer; all uncaught tables remain not caught up');
        return true;
    }

    warnIfNoFeedUrl(peer) {
        const name = peer.identity || peer.addr;
        const now = Date.now();
        const lastWarnAt = this.lastNoFeedUrlWarnAt.get(name);
        if (lastWarnAt !== undefined && now - lastWarnAt < this.warnIntervalMs) return false;
        this.lastNoFeedUrlWarnAt.set(name, now);
        this.logger.warn('Hub DB peer catch-up: connected signer-set peer ' + name +
            ' has no fetchable feed URL; skipping');
        return true;
    }

    async catchUpTable(peer, table, verifier, peerIdentity) {
        let cursor = 0;
        for (;;) {
            const page = await this.fetchPage(peer, table, cursor, this.pageSize);
            if (!page || page.table !== table || !Array.isArray(page.rows)) {
                throw new Error('Invalid snapshot page for ' + table);
            }
            for (const row of page.rows) {
                const wireId = Number(row && row.id);
                if (!Number.isSafeInteger(wireId) || wireId <= cursor) {
                    throw new Error('Snapshot row has a non-advancing wire id');
                }
                cursor = wireId;
                let verdict;
                try {
                    verdict = await verifier(row, {
                        table, peer, peerIdentity, db: this.db,
                        authenticated: true, signerSetPeer: true
                    });
                } catch (e) {
                    verdict = { ok: false, reason: e && e.message ? e.message : String(e) };
                }
                if (!verifierAccepted(verdict)) {
                    this.logger.warn('Hub DB peer catch-up verifier refused ' + table +
                        ' row ' + wireId + ' from ' + peer + ': ' + refusalReason(verdict));
                    continue;
                }
                const localRow = withoutWireId(row);
                if (await this.hasRow(table, localRow)) continue;
                await this.storeRow(table, localRow);
            }
            if (page.rows.length < this.pageSize) return;
        }
    }
}

module.exports = Object.assign(HubDbPeerCatchup, {
    connectedSignerPeers,
    peerFeedUrl,
    requestJson,
    rowAlreadyHeld,
    storeVerifiedRow
});
