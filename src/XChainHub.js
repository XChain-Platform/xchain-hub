/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Hub - Hub Class
 *
 * This file handles starting the hub and managing service configs.
 *
 ********************************************************************/

const Database = require('./db.js');
const PARAMETER_LIST = ["host", "port", "service_port", "db_host", "db_port", "name", "user", "pass"];

class XChainHub {
    constructor(dbHost, dbPort, dbName, dbUser, dbPass) {
        this.dbHost = dbHost;
        this.dbPort = dbPort;
        this.dbName = dbName;
        this.dbUser = dbUser;
        this.dbPass = dbPass;
        this.db     = null;
    }

    async start(){
        this.db = new Database(this.dbHost, this.dbPort, this.dbName, this.dbUser, this.dbPass);
        await this.db.createDatabase();
        await this.db.verifyTables();
        console.log('XChain Hub started (MariaDB: ' + this.dbName + ')');
    }

    async addCoinNetworkParameter(coin, network, module, parameterName, parameterValue){
        await this.db.setParam(coin, network, module, parameterName, parameterValue);
        return true;
    }

    async addParametersFromJson(json){
        for(let nextCoin in json){
            if(nextCoin != ""){
                for(let nextNetwork in json[nextCoin]){
                    for(let nextModule in json[nextCoin][nextNetwork]){
                        for(let nextParam of PARAMETER_LIST){
                            let nextValue = json[nextCoin][nextNetwork][nextModule][nextParam];
                            if(nextValue !== null && nextValue !== undefined){
                                await this.addCoinNetworkParameter(nextCoin, nextNetwork, nextModule, nextParam, nextValue);
                            }
                        }
                    }
                }
            }
        }
        return true;
    }

    async getAllConfigs(){
        return await this.db.getAllConfigs();
    }

    async close(){
        if(this.db) await this.db.close();
    }
}

module.exports = XChainHub;
