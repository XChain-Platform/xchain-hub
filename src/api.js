const dotenv = require('dotenv')
dotenv.config()

const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const cors = require('cors');
const XChainHub  = require('./XChainHub');
const jsonRouter = require('express-json-rpc-router')

const DB_NAME =  "xchain-hub"
const LISTEN_PORT = 3000

async function startApi(){
    //Start the monitor
    const hub = new XChainHub();
    hub.start()

    // Create the app
    const app = express();

    // Use Helmet to increase security
    app.use(helmet());

    // Allow JSON requests
    app.use(bodyParser.json());

    // Allow CORS for development
    app.use(cors());


    const jsonRpcController = {

        // Function to check if xchain-hub is up
        async ping() {
            return {status:"success"};
        },
        // Function to create transactions hex for a given data and encoding type
        async getallconfigs() {
            try {
                let configs = await hub.getAllConfigs()
                return configs
            } catch (err) {
                return {error:"there was an error trying to update the config of "+coin+"-"+network};
            }
        },
        async updateconfig(coin, network, newConfigJson){
            try {
                await hub.addParametersFromJson(coin, network, newConfigJson)
                return {status:"success"}
            } catch (err) {
                return {error:"there was an error trying to update the config of "+coin+"-"+network};
            }
        }
    }

    // Allow JSON-RPC requests
    app.use(jsonRouter({methods: jsonRpcController}))


    // Start the server
    app.listen(LISTEN_PORT, () => {
      console.log('API listening on port '+LISTEN_PORT);
    });
}

startApi()