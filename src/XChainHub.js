const util = require('./util')
const axios = require('axios');
axios.defaults.timeout = 5000
const LevelUpStore = require('./LevelUpDb.js')

class XChainHub {
    constructor(dbName) {
      this.dbName = dbName
      
      this.db = null
    }
    
    async addCoinNetworkParameter(coin, network, module, parameterName, parameterValue){
        try {
            await this.db.setParam(coin, network, module, parameterName, parameterValue)
            return true
        } catch (err){
            throw new Error("There was an error trying to add the parameter "+parameterName+"("+parameterValue+")"+" in "+coin+"-"+network)
        }
    }
    
    async addParametersFromJson(coin, network, module, json){
        let jsonParsed = JSON.parse(json)
        
        try {
            let parameterList = ["host", "port", "name", "user", "pass"]
        
        
            for (let nextParamIndex in parameterList){
                let nextParam = parameterList[nextParamIndex]
                this.db.addCoinNetworkParameters(coin, network, module, nextParam, jsonParsed[nextParam])
            }
            
        } catch(err){
            throw err
        }
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