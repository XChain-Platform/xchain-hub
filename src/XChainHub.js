//const util = require('./util')
const axios = require('axios');
axios.defaults.timeout = 5000
const LevelUpStore = require('./LevelUpDb.js')
const PARAMETER_LIST = ["host", "port", "service_port", "name", "user", "pass"]


class XChainHub {
    constructor(dbName) {
      this.dbName = dbName
      
      this.db = null
    }
    
    async start(){
        this.db = new LevelUpStore(this.dbName)
        await this.db.createDatabase()
    }
    
    async addCoinNetworkParameter(coin, network, module, parameterName, parameterValue){
        try {
            await this.db.setParam(coin, network, module, parameterName, parameterValue)
            return true
        } catch (err){
            throw new Error("There was an error trying to add the parameter "+parameterName+"("+parameterValue+")"+" in "+coin+"-"+network)
        }
    }
    
    async addParametersFromJson(json){
        for (let nextCoin in json){
            if (nextCoin != ""){
            
                for (let nextNetwork in json[nextCoin]){
                    
                    for (let nextModule in json[nextCoin][nextNetwork]){
                        try {
                            for (let nextParam of PARAMETER_LIST){
                                await this.addCoinNetworkParameter(nextCoin, nextNetwork, nextModule, nextParam, json[nextCoin][nextNetwork][nextModule][nextParam])
                            }
                            
                        } catch(err){
                            throw err
                        }
                    }
                }
            }
        }
        
        return true
    }
    
    async getAllConfigs(){
        try {
            let configs = await this.db.getAllConfigs()
            
            return configs
        } catch (err) {
            throw new Error("There was an error trying to get all the coins/networks configs for this server")
        }
    }
}

module.exports = XChainHub