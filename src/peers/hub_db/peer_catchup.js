'use strict';

const http = require('http');
const https = require('https');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const registry = require('./catchup_verifiers.js');
const { createIndexerReadMemo } = require('../../oracle/price_aggregator/capability_catchup_verifier.js');
const { createCatchupState } = require('./catchup_state.js');
const { createPeerFeedBackoff } = require('./peer_feed_backoff.js');
const { advanceCursor, groupKey, indexGroups, holdTrailingGroup } = require('./price_round_groups.js');
const { withoutWireId, rowAlreadyHeld, storeVerifiedRow } = require('./catchup_rows.js');

// The snapshot routes serve at most 10000 rows a page; asking for fewer only multiplies requests.
const DEFAULT_PAGE_SIZE = 10000;
const DEFAULT_WARN_INTERVAL_MS = 60000;
const DEFAULT_RETRY_INTERVAL_MS = 5000;
const DEFAULT_MAX_RETRY_INTERVAL_MS = 300000;
const DEFAULT_INDEXER_READ_INTERVAL_MS = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

function positiveOr(value, fallback) {
    return Number(value) > 0 ? Number(value) : fallback;
}

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

// Keeps the status and Retry-After so the caller can back off a refusing peer.
function refusedRequestError(res) {
    const err = new Error('Snapshot request returned HTTP ' + res.statusCode);
    const retryAfterSeconds = Number(res.headers && res.headers['retry-after']);
    err.statusCode = res.statusCode;
    err.retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0 ? retryAfterSeconds * 1000 : null;
    return err;
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
                    reject(refusedRequestError(res));
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

class HubDbPeerCatchup {
    constructor(options) {
        const opts = options || {};
        this.db = opts.db;
        this.peerManager = opts.peerManager;
        this.feedKey = opts.feedKey || '';
        this.pageSize = positiveOr(opts.pageSize, DEFAULT_PAGE_SIZE);
        this.warnIntervalMs = positiveOr(opts.warnIntervalMs, DEFAULT_WARN_INTERVAL_MS);
        this.retryIntervalMs = positiveOr(opts.retryIntervalMs, DEFAULT_RETRY_INTERVAL_MS);
        this.maxRetryIntervalMs = positiveOr(opts.maxRetryIntervalMs, DEFAULT_MAX_RETRY_INTERVAL_MS);
        this.indexerReadIntervalMs = opts.indexerReadIntervalMs === 0
            ? 0 : positiveOr(opts.indexerReadIntervalMs, DEFAULT_INDEXER_READ_INTERVAL_MS);
        this.currentRetryIntervalMs = this.retryIntervalMs;
        this.feedBackoff = createPeerFeedBackoff({ retryIntervalMs: this.retryIntervalMs,
            maxRetryIntervalMs: this.maxRetryIntervalMs, now: () => Date.now() });
        this.nextRetryAt = 0;
        this.requestTimeoutMs = positiveOr(opts.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
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
        this.warnTimer = this.retryTimer = this.lastNoPeerWarnAt = null;
        this.lastNoFeedUrlWarnAt = new Map();
        this.started = false;
        this.onPeerConnect = peerAddr => this.isListedSignerPeer(peerAddr) && this.schedule();
    }

    start() {
        if (this.started) return this.runningPromise || Promise.resolve();
        this.started = true;
        if (this.peerManager && typeof this.peerManager.on === 'function') this.peerManager.on('peer:connect', this.onPeerConnect);
        this.warnTimer = setInterval(() => this.warnIfNoPeer(), this.warnIntervalMs).unref();
        this.retryTimer = setInterval(() => this.onRetryTick(), this.retryIntervalMs).unref();
        return this.schedule();
    }

    stop() {
        clearInterval(this.warnTimer);
        clearInterval(this.retryTimer);
        this.warnTimer = this.retryTimer = null;
        if (this.peerManager && typeof this.peerManager.removeListener === 'function') {
            this.peerManager.removeListener('peer:connect', this.onPeerConnect);
        }
        this.started = false;
    }

    isListedSignerPeer(peerAddr) {
        const peers = connectedSignerPeers(this.peerManager);
        return peers.some(peer => peerAddr == null || peer.addr === peerAddr || peer.identity === peerAddr);
    }

    onRetryTick() {
        if (this.runningPromise) return;
        if (this.allCaughtUp()) this.currentRetryIntervalMs = this.retryIntervalMs;
        else if (this.retryDue()) this.schedule({ onlyBehind: true }).then(() => this.backOffRetry());
    }

    retryDue() {
        const peers = connectedSignerPeers(this.peerManager);
        const feedUrls = peers.map(peer => peer.feedUrl).filter(Boolean);
        const now = Date.now();
        return peers.length > 0 && now >= this.nextRetryAt && now >= this.feedBackoff.earliestRetryAt(feedUrls);
    }

    backOffRetry() {
        if (this.allCaughtUp()) {
            this.currentRetryIntervalMs = this.retryIntervalMs;
            return;
        }
        this.nextRetryAt = Date.now() + this.currentRetryIntervalMs;
        this.currentRetryIntervalMs = Math.min(this.currentRetryIntervalMs * 2, this.maxRetryIntervalMs);
    }

    schedule(options) {
        if (this.runningPromise) {
            this.rerunRequested = true;
            return this.runningPromise;
        }
        this.runningPromise = this.run(options).finally(() => {
            this.runningPromise = null;
            if (this.rerunRequested) {
                this.rerunRequested = false;
                this.schedule();
            }
        });
        return this.runningPromise;
    }

    tableCaughtUp(table) { return this.state.isTableCaughtUp(table); }
    caughtUpState() { return this.state.status(); }
    allCaughtUp() { return this.state.isCaughtUp(); }

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

    async run(options) {
        const onlyBehind = Boolean(options && options.onlyBehind);
        const peers = connectedSignerPeers(this.peerManager);
        if (peers.length === 0) {
            this.lastUsablePeerCount = 0;
            this.warnIfNoPeer();
            return this.caughtUpState();
        }
        const fetchablePeers = peers.filter(peer => peer.feedUrl || (this.warnIfNoFeedUrl(peer) && false));
        this.lastUsablePeerCount = fetchablePeers.length;
        const reads = createIndexerReadMemo(this.db, this.indexerReadIntervalMs);
        for (const table of this.tables) {
            if (onlyBehind && this.state.isTableCaughtUp(table)) continue;
            const verifier = this.getVerifier(table);
            if (!verifier) continue;
            await this.walkTable(fetchablePeers, table, verifier, reads);
        }
        return this.caughtUpState();
    }

    async walkTable(peers, table, verifier, reads) {
        this.state.markBehind(table);
        for (const peer of peers) {
            if (this.feedBackoff.isBackedOff(peer.feedUrl)) continue;
            try {
                const left = await this.catchUpTable(peer.feedUrl, table, verifier, peer.identity, reads);
                this.feedBackoff.noteSuccess(peer.feedUrl);
                if (left === true) this.state.markBehind(table);
                else this.state.markCaughtUp(table);
                return;
            } catch (e) {
                this.feedBackoff.noteFailure(peer.feedUrl, e);
                this.logger.warn(nodeUtil.format('Hub DB peer catch-up failed for ' + table +
                    ' from ' + peer.feedUrl + ':', e && e.message ? e.message : e));
            }
        }
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

    async verifyRow(verifier, row, context) {
        try {
            return await verifier(row, context);
        } catch (e) {
            return { ok: false, reason: e && e.message ? e.message : String(e) };
        }
    }

    async catchUpTable(peer, table, verifier, peerIdentity, reads) {
        const walk = { peer, table, verifier, peerIdentity, reads, cursor: 0, leftBehind: false, carry: [] };
        for (;;) {
            const page = await this.fetchPage(peer, table, walk.cursor, this.pageSize);
            if (!page || page.table !== table || !Array.isArray(page.rows)) {
                throw new Error('Invalid snapshot page for ' + table);
            }
            walk.cursor = advanceCursor(walk.cursor, page.rows);
            const full = page.rows.length >= this.pageSize;
            const batch = holdTrailingGroup(walk.carry.concat(page.rows), full);
            walk.carry = batch.held;
            await this.processBatch(walk, batch.ready);
            if (!full) return walk.leftBehind;
        }
    }

    async processBatch(walk, rows) {
        const groups = indexGroups(rows);
        const verdicts = new Map();
        for (const row of rows) {
            const localRow = withoutWireId(row);
            if (await this.hasRow(walk.table, localRow)) continue;
            const key = groupKey(row) || 'row:' + row.id;
            if (!verdicts.has(key)) verdicts.set(key, await this.verifyWalkRow(walk, row, groups.get(key)));
            if (verifierAccepted(verdicts.get(key))) await this.storeRow(walk.table, localRow);
        }
    }

    async verifyWalkRow(walk, row, priceRoundRows) {
        const { peer, table, reads } = walk;
        const failedBefore = reads ? reads.failedServes : 0;
        const verdict = await this.verifyRow(walk.verifier, row, {
            table, peer, peerIdentity: walk.peerIdentity, db: this.db, authenticated: true, signerSetPeer: true,
            readCapabilitySnapshot: reads ? reads.read : undefined, priceRoundRows
        });
        if (verifierAccepted(verdict)) return verdict;
        this.logger.warn('Hub DB peer catch-up verifier refused ' + table +
            ' row ' + Number(row.id) + ' from ' + peer + ': ' + refusalReason(verdict));
        if (reads && reads.failedServes > failedBefore) walk.leftBehind = true;
        return verdict;
    }
}

module.exports = Object.assign(HubDbPeerCatchup, {
    connectedSignerPeers, peerFeedUrl, requestJson, rowAlreadyHeld, storeVerifiedRow, DEFAULT_PAGE_SIZE
});
