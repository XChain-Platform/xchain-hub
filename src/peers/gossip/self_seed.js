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
 ********************************************************************/

const dns = require('node:dns').promises;
const net = require('node:net');
const os = require('node:os');
const { getLogger } = require('../../observability');
const logger = getLogger();

function splitHostPort(addr) {
    const match = /^(?:wss?:\/\/)?(?:\[([^\]]+)\]|([\w.\-]+)):(\d+)$/.exec(String(addr || ''));
    return match ? { host: (match[1] || match[2]).toLowerCase(), port: parseInt(match[3], 10) } : null;
}

function normalizeIp(addr) {
    const value = String(addr || '').split('%')[0].toLowerCase();
    return value.startsWith('::ffff:') ? value.slice(7) : value;
}

function localAddresses() {
    const addresses = new Set(['127.0.0.1', '::1', 'localhost']);
    for (const list of Object.values(os.networkInterfaces())) {
        for (const entry of list || []) addresses.add(normalizeIp(entry.address));
    }
    return addresses;
}

async function resolveAddresses(host, lookup) {
    if (net.isIP(host)) return new Set([normalizeIp(host)]);
    if (host === 'localhost') return new Set(['127.0.0.1', '::1']);
    const found = await (lookup || dns.lookup)(host, { all: true });
    const records = Array.isArray(found) ? found : [found];
    return new Set(records.map(record => normalizeIp(record && record.address)).filter(Boolean));
}

function listenerEndpoint(pm) {
    const bound = pm.httpServer && typeof pm.httpServer.address === 'function'
        ? pm.httpServer.address()
        : null;
    return {
        host: bound && bound.address ? bound.address : (pm.config.P2P_HOST || '0.0.0.0'),
        port: parseInt(bound && bound.port, 10) || parseInt(pm.config.P2P_PORT, 10) || 10001
    };
}

async function listenerAddresses(pm, lookup) {
    const host = String(listenerEndpoint(pm).host).toLowerCase();
    if (host === '0.0.0.0' || host === '::') return localAddresses();
    return resolveAddresses(host, lookup);
}

class PeerSelfSeed {

    async isOwnListener(addr, lookup) {
        const seed = splitHostPort(addr);
        if (!seed || seed.port !== listenerEndpoint(this).port) return false;
        const own = splitHostPort(this.validatorAddr);
        if (own && own.host === seed.host && own.port === seed.port) return true;
        try {
            const resolved = await resolveAddresses(seed.host, lookup);
            const listeners = await listenerAddresses(this, lookup);
            if ([...resolved].some(address => listeners.has(address))) return true;
            if (!own || own.port !== seed.port) return false;
            const advertised = await resolveAddresses(own.host, lookup);
            return [...resolved].some(address => advertised.has(address));
        } catch (e) {
            return false;
        }
    }

    async dialSeedPeers() {
        let seeds = this.config.SEED_NODES || [];
        if (seeds.length === 0) {
            const defaults = this.constructor.bootstrapSeeds(this.config.HUB_NETWORK);
            if (defaults.length) {
                seeds = defaults;
                logger.info('PeerManager: no SEED_NODES configured; using the ' + seeds.length +
                            ' default bootstrap seed(s) for ' + this.config.HUB_NETWORK);
            }
        }
        for (const addr of seeds) {
            if (await this.isOwnListener(addr, this.seedLookup)) {
                logger.info('PeerManager: seed ' + addr + ' is this hub\'s own listener; not dialing');
                continue;
            }
            if (!this.running) return;
            this.connectToPeer(addr);
            this.recordPeer(addr, addr, true);
        }
    }
}

module.exports = PeerSelfSeed;
