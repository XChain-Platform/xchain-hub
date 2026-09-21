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
 * XChain Hub - Config Parameters
 *
 * The coin/network/module parameter tree this hub stores and serves: which
 * keys it accepts, how a pushed JSON document becomes rows, and the cursor
 * consumers poll it with.
 *
 ********************************************************************/

const { getLogger } = require('../observability');
const logger = getLogger();

// self_sync rides the same string-parameter path as the rest of this list: it
// marks a checkpoint-schema descriptor (coin/network module "checkpoint",
// row 39 / #4138 decoupling) as one the explorer's own HubMirrorSyncManager
// self-provisions and populates, rather than an externally-maintained hub
// schema. Coerced to the string "true"/"false" like every other value here;
// xchain-explorer's db.js reads it back with `=== true || === 'true'`.
//
// hub_url travels WITH self_sync, in the same checkpoint block, and belongs on this
// list for that reason: a self-syncing explorer needs the hub endpoint its mirror
// writer follows, and xchain-node ships the two together precisely so they cannot
// arrive by different paths. This list is the path, and while it named self_sync
// alone it silently dropped the endpoint out of every pushed block - so an explorer
// whose container env carried no HUB_API_URL was told to self-sync with nowhere to
// sync from, and served a mirror nothing writes (or, once the explorer started
// refusing that state, no mirror at all: the hub-mirrored routes then 500 per
// request for that coin while its siblings answer normally).
const PARAMETER_LIST     = ["host", "port", "service_port", "db_host", "db_port", "name", "user", "pass", "self_sync", "hub_url"];
const OPERATIONAL_PARAMS = new Set(["GAS_PRICE", "ACTIVATION_DELAY_BLOCKS", "EXPIRATION_FEE_PER_DAY"]);
const JSON_BLOB_PARAMS   = new Set(["GAS_SCHEDULE", "STAKING"]);

// The string-valued parameters of one (coin, network, module): the transport
// keys every module carries, then the operational ones.
function collectParamRows(rows, moduleLevel, nextCoin, nextNetwork, nextModule) {
    for(let nextParam of PARAMETER_LIST){
        let nextValue = moduleLevel[nextParam];
        if(nextValue === null || nextValue === undefined) continue;

        if (typeof nextValue !== 'string') {
            logger.warn('XChainHub.applyConfig: non-string value for ' + nextParam + ': coercing');
            nextValue = String(nextValue);
        }
        if (nextValue.length > 1024) {
            throw new Error('Config value for ' + nextParam + ' exceeds max length of 1024 chars');
        }

        rows.push({
            coin:       nextCoin,
            network:    nextNetwork,
            module:     nextModule,
            paramName:  nextParam,
            paramValue: nextValue
        });
    }

    for(let nextParam of OPERATIONAL_PARAMS){
        let nextValue = moduleLevel[nextParam];
        if(nextValue === null || nextValue === undefined) continue;

        if (typeof nextValue !== 'string') {
            logger.warn('XChainHub.applyConfig: non-string value for ' + nextParam + ': coercing');
            nextValue = String(nextValue);
        }
        if (nextValue.length > 1024) {
            throw new Error('Config value for ' + nextParam + ' exceeds max length of 1024 chars');
        }

        rows.push({
            coin:       nextCoin,
            network:    nextNetwork,
            module:     nextModule,
            paramName:  nextParam,
            paramValue: nextValue
        });
    }
}

// The JSON blob params (GAS_SCHEDULE, STAKING), serialized to a JSON string
// before storage.
function collectJsonBlobRows(rows, moduleLevel, nextCoin, nextNetwork, nextModule) {
    // The JSON blob params (GAS_SCHEDULE, STAKING), serialized to a JSON
    // string before storage.
    for(let nextParam of JSON_BLOB_PARAMS){
        let nextValue = moduleLevel[nextParam];
        if(nextValue === null || nextValue === undefined) continue;

        if (typeof nextValue === 'object') {
            nextValue = JSON.stringify(nextValue);
        } else if (typeof nextValue !== 'string') {
            nextValue = String(nextValue);
        }
        if (nextValue.length > 1024) {
            throw new Error('Config value for ' + nextParam + ' exceeds max length of 1024 chars');
        }

        rows.push({
            coin:       nextCoin,
            network:    nextNetwork,
            module:     nextModule,
            paramName:  nextParam,
            paramValue: nextValue
        });
    }
}

class ConfigParams {

    async addParametersFromJson(json){
        if(this.consensus){
            await this.consensus.propose(json);
            return true;
        }
        await this.applyConfig(json);
        return true;
    }

    async applyConfig(json){
        if (!json || typeof json !== 'object' || Array.isArray(json))
            throw new Error('Config must be a non-null object');

        let rows = [];
        for(let nextCoin in json){
            if(nextCoin === '') continue;
            let coinLevel = json[nextCoin];
            if (!coinLevel || typeof coinLevel !== 'object') continue;

            for(let nextNetwork in coinLevel){
                let networkLevel = coinLevel[nextNetwork];
                if (!networkLevel || typeof networkLevel !== 'object') continue;

                for(let nextModule in networkLevel){
                    let moduleLevel = networkLevel[nextModule];
                    if (!moduleLevel || typeof moduleLevel !== 'object') continue;

                    collectParamRows(rows, moduleLevel, nextCoin, nextNetwork, nextModule);
                    collectJsonBlobRows(rows, moduleLevel, nextCoin, nextNetwork, nextModule);
                }
            }
        }

        if(rows.length > 0){
            await this.db.setParams(rows);
        }
    }

    // sinceUpdatedAt (optional): an epoch-seconds cursor. Supplied, only rows changed
    // after that instant come back; omit it for the full tree.
    async getAllConfigs(sinceUpdatedAt){
        return await this.db.getAllConfigs(sinceUpdatedAt);
    }

    // High-water mark (epoch seconds) consumers thread back as the cursor above.
    async getConfigWatermark(){
        return await this.db.getConfigWatermark();
    }

    // Last committed PBFT sequence (0 on a fresh node), so consumers can detect a
    // committed config change between polls.
    async getLastSeq(){
        return await this.db.getLastSeq();
    }
}

module.exports = ConfigParams;
