'use strict';

const http = require('http');

/**
 * Send a JSON-RPC 2.0 request to a hub instance.
 * @param {number} port - HTTP port
 * @param {string} method - JSON-RPC method name
 * @param {object} params - Method parameters
 * @returns {Promise<object>} Parsed JSON-RPC response
 */
function callRpc(port, method, params) {
    return new Promise((resolve, reject) => {
        let body = JSON.stringify({
            jsonrpc: '2.0',
            id:      1,
            method:  method,
            params:  params || {}
        });

        let req = http.request({
            hostname: '127.0.0.1',
            port:     port,
            path:     '/',
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { resolve({ raw: data, statusCode: res.statusCode }); }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

module.exports = { callRpc };
