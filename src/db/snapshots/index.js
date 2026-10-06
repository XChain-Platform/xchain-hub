const capabilitySnapshots = require('./capability_snapshots.js');
const listSnapshots       = require('./list_snapshots.js');
const policySnapshots     = require('./policy_snapshots.js');

module.exports = Object.assign({}, capabilitySnapshots, listSnapshots, policySnapshots);
