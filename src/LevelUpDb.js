//const util = require('./util')

var levelup = require('levelup')
var leveldown = require('leveldown')

const PREFIX_PARAM = "P"


class LevelUpStore {
    constructor(dbName) {
        this.dbName = dbName
        this.db = null
    }
  
    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
  
    async createDatabase() {
        try {
            this.db = levelup(leveldown("/data/"+this.dbName))  
            return this.db
        } catch (err){
            throw new Error("Couldn't open/create levelup database")
        }
    }
    
    getCoinNetworkModuleKey(coin, network, module){
        return coin+"-"+network+"-"+module
    }
    
    getParamKey(coin, network, module, paramName){
        return PREFIX_PARAM+":"+this.getCoinNetworkModuleKey(coin, network, module) + ":" + paramName
    }
    
    async setParam(coin, network, module, paramName, paramValue){
        let key = this.getParamKey(coin, network, module, paramName)
      
        this.db.put(key, paramValue)
        return true
    }
    
    async getConfig(coin, network, module){
        let thisObject = this
        let coinNetworkModuleKey = PREFIX_PARAM+":"+this.getCoinNetworkModuleKey(coin, network, module)
        
        return new Promise((resolve, reject) => {
            var config = []
            const options = {
                gte: coinNetworkModuleKey,
                lte: coinNetworkModuleKey+"\xFF",
                keys: true,
                values: true
            }

            const stream = this.db.createReadStream(options);

            stream.on('data', async function(data) {
                let keySplit = data.key.toString("utf-8").split(":")
                let paramName = keySplit[2]
                let paramValue = data.value
                
                config[paramName] = paramValue
            })

            stream.on('error', function(err) {
                reject(err)
            })

            stream.on('end', function() {
                resolve(config)
            })
        })
    }
    
    async getAllConfigs(coin, network){
        let thisObject = this
        
        return new Promise((resolve, reject) => {
        var config = {}
            const options = {
                gte: PREFIX_PARAM+":",
                lte: PREFIX_PARAM+":"+"\xFF",
                keys: true,
                values: true
            }

            const stream = thisObject.db.createReadStream(options);

            stream.on('data', async function(data) {
                let keySplit = data.key.toString("utf-8").split(":")
                let coinNetworkModuleSplit = keySplit[1].split("-")
                let coin = coinNetworkModuleSplit[0]
                let network = coinNetworkModuleSplit[1]
                let module = coinNetworkModuleSplit.slice(2).join("-")
                let paramName = keySplit[2]
                let paramValue = data.value.toString()
                
                
                if (!(coin in config)){
                    config[coin] = {}
                }
                
                if (!(network in config[coin])){
                    config[coin][network] = {}
                }
                
                if (!(module in config[coin][network])){
                    config[coin][network][module] = {}
                }
                
                config[coin][network][module][paramName] = paramValue
            })

            stream.on('error', function(err) {
                reject(err)
            })

            stream.on('end', function() {
                resolve(config)
            })
        })
    }
}

module.exports = LevelUpStore