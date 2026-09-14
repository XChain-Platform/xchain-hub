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
 * XChain Hub - Indexer Resolution
 *
 * Which indexer this hub talks to for a coin, on which network, and the
 * refusal that fires when the one it resolved answers for another chain.
 *
 ********************************************************************/

const { axiosFor } = require('./indexer_http.js');
const hubConfig = require('../config');
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();

class IndexerUrls {

    // Which BTC network this hub talks to. For a hub that DECLARED one (every validator,
    // and a standalone hub whose operator set HUB_NETWORK) the answer is this.network and
    // nothing else; the configs table only confirms that network has an indexer, and a
    // tree carrying only OTHER networks throws. The old first-found order let a mainnet
    // validator anchor its oracle round to the REGTEST tip while every consensus gate
    // still read mainnet, and _indexerCoinMismatch cannot see that, because a regtest
    // BTC indexer truthfully reports coin=BTC. A hub with no declared network keeps the
    // regtest>testnet>mainnet order for dev loops, defaulting to mainnet when no configs
    // have loaded yet.
    async resolveBtcNetwork(){
        // A hub told which network it is never guesses: with no configs, its own is the answer.
        if(!this.db) return this.network || 'mainnet';
        let configs;
        try { configs = await this.db.getAllConfigs(); }
        catch (err) {
            logger.error(nodeUtil.format('XChainHub: failed to resolve BTC network from configs:', err));
            return this.network || 'mainnet';
        }
        let btc = configs && configs['bitcoin'];
        if(this.network){
            if(btc && btc[this.network] && btc[this.network]['xchain-indexer']) return this.network;
            // Nothing configured is not a cross-network hazard; a tree with other
            // networks but not ours is, so refuse rather than resolve one.
            if(!btc || Object.keys(btc).length === 0) return this.network;
            // OUR network being present is not a hazard either, whatever sections it
            // carries. An indexer's pushChainTip writes bitcoin.<network>.chain_tips,
            // so the mere act of a BTC indexer reporting its tip populated this tree
            // with our own network and no 'xchain-indexer' section, and the throw below
            // then fired on a hub whose only bitcoin config was its own. That took out
            // the BTC anchor on exactly the hub the indexers talk to. The cross-network
            // question is answered by WHICH networks appear, not by which sections they
            // hold, so resolve ours and let the caller fall through to
            // BTC_INDEXER_API_URL when no indexer URL is configured here.
            if(btc[this.network]) return this.network;
            throw new Error('XChainHub: HUB_NETWORK=' + this.network + ' has no bitcoin xchain-indexer in the ' +
                'configs table (present: ' + Object.keys(btc).join(', ') + '); refusing to anchor consensus to ' +
                'another network. Set BTC_INDEXER_API_URL, or push the ' + this.network + ' indexer via updateconfig.');
        }
        if(!btc) return 'mainnet';
        for(let net of ['regtest', 'testnet', 'mainnet']){
            if(btc[net] && btc[net]['xchain-indexer']) return net;
        }
        return 'mainnet';
    }

    // Attaches x-api-key when BTC_INDEXER_API_KEY is set; one shared key for all
    // hub-to-indexer traffic (the same var RewardTracker uses).
    btcIndexerHeaders(){
        let headers = { 'Content-Type': 'application/json' };
        let key = hubConfig.BTC_INDEXER_API_KEY || '';
        if(key) headers['x-api-key'] = key;
        return headers;
    }

    // Resolution order is _resolveIndexerUrl's, below: the explicit BTC_INDEXER_API_URL
    // override, then the BTC_INDEXER_URL alias, then the hub's own configs table, and
    // null when none yields a usable URL. The alias matters most here, since a hub
    // setting only that name falls back to seed-local snapshots and self-signs at
    // quorum 0. The URL is then VERIFIED to be a BTC indexer, because capability
    // staking is BTC-only and on a venue with no BTC leg the lookup returns the DOGE
    // indexer's foreign heights and stake: the hub elects publishers off a set that
    // does not exist and snapshots at a height where the stake is not active, without
    // one error line. A POSITIVE identification of a non-BTC indexer fails loud and
    // closed; an unreachable or silent one keeps the legacy behaviour, because
    // "cannot verify" is not evidence of a misconfiguration.
    async _resolveBtcIndexerUrl(){
        let url = await this._resolveIndexerUrl('BTC');
        if(!url) return null;
        if(await this._indexerCoinMismatch(url, 'BTC')) return null;
        return url;
    }

    // True only when the indexer at `url` positively reports serving a coin other than
    // `want`. Unknown, unreachable or no coin field means false, so an unverifiable
    // answer never blocks. Verdicts cache per URL: 'ok' is permanent for the process,
    // a mismatch is re-probed on the TTL so a repointed hub recovers on its own.
    async _indexerCoinMismatch(url, want){
        if(hubConfig.INDEXER_COIN_CHECK === '0') return false;
        if(!this._indexerCoinVerdicts) this._indexerCoinVerdicts = new Map();
        const RECHECK_MS = 60000;
        let key    = want + '@' + url;
        let cached = this._indexerCoinVerdicts.get(key);
        if(cached && (cached.verdict === 'ok' || (Date.now() - cached.at) < RECHECK_MS))
            return cached.verdict === 'mismatch';

        let coin = null;
        try {
            // getblockhashes is the one federation read that names the chain it answers for,
            // and it is already on the hub's allowed surface.
            let res = await axiosFor(this).post(url, {
                jsonrpc: '2.0', id: Date.now(), method: 'getblockhashes', params: {}
            }, { headers: this.btcIndexerHeaders(), timeout: 5000 });
            let result = res && res.data && res.data.result;
            if(result && !result.error && result.coin) coin = String(result.coin).toUpperCase();
        } catch(_){ /* unreachable: unverifiable, not a mismatch */ }

        if(!coin){
            this._indexerCoinVerdicts.set(key, { verdict: 'unknown', at: Date.now() });
            return false;
        }
        if(coin === String(want).toUpperCase()){
            this._indexerCoinVerdicts.set(key, { verdict: 'ok', at: Date.now() });
            return false;
        }
        this._indexerCoinVerdicts.set(key, { verdict: 'mismatch', at: Date.now() });
        logger.error('XChainHub: the resolved ' + want + ' indexer at ' + url + ' is a ' + coin +
            ' indexer, not ' + want + '. ' + want + '-anchored reads (capability snapshots, the ' +
            'publisher election, snapshot_block) would silently use another chain\'s state, so ' +
            'they are DISABLED until this is fixed. Set ' + want + '_INDEXER_API_URL to a real ' +
            want + ' indexer (or push the right config via updateconfig).');
        return true;
    }

    // Per-coin indexer JSON-RPC URL: env <COIN>_INDEXER_API_URL, then <COIN>_INDEXER_URL,
    // then the hub's configs table (xchain-node's updateconfig push), so a configs-only
    // hub still reaches its indexers. Returns null when nothing is configured.
    async _resolveIndexerUrl(coin){
        coin = String(coin || '').toUpperCase();
        if(process.env[coin + '_INDEXER_API_URL']) return process.env[coin + '_INDEXER_API_URL'];
        if(process.env[coin + '_INDEXER_URL']) return process.env[coin + '_INDEXER_URL'];
        if(!this.db) return null;
        let configs;
        try { configs = await this.db.getAllConfigs(); }
        catch (err) { logger.error(nodeUtil.format('XChainHub: failed to resolve ' + coin + ' indexer URL from configs:', err)); return null; }
        const COIN_CONFIG_KEY = { BTC: 'bitcoin', LTC: 'litecoin', DOGE: 'dogecoin' };
        let cc = configs && configs[COIN_CONFIG_KEY[coin] || coin.toLowerCase()];
        if(!cc) return null;
        // xchain-node's updateconfig push uses nested {host, port, ...} under the module key
        let urlFor = (netConfig) => {
            if(!netConfig) return null;
            let nested = netConfig['xchain-indexer'];
            let host = (nested && nested['host']) || netConfig['INDEXER_URL'];
            let port = (nested && nested['port']) || netConfig['INDEXER_API_PORT'];
            return (host && port) ? ('http://' + host + ':' + port) : null;
        };
        // A hub that declared its network (any validator, and a standalone hub whose
        // operator set HUB_NETWORK) reads ONLY that network's indexer. The preference
        // order below is a dev-loop convenience for a hub that declared none, and on a
        // multi-network tree it silently handed a mainnet-gated hub the regtest indexer,
        // which then fed the checkpoint, attestation and cross-chain engines another
        // chain's state.
        if(this.network) return urlFor(cc[this.network]);
        // Standalone or dev (no HUB_NETWORK, so no consensus runs): prefer regtest >
        // testnet > mainnet so dev loops Just Work. Production should set
        // <COIN>_INDEXER_API_URL explicitly.
        for(let net of ['regtest', 'testnet', 'mainnet']){
            let url = urlFor(cc[net]);
            if(url) return url;
        }
        return null;
    }
}

module.exports = IndexerUrls;
