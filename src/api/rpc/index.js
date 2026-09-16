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
 * XChain Hub - the JSON-RPC controller.
 *
 * Merges the route families under this directory into the one flat method
 * table express-json-rpc-router dispatches on. Families are grouped by
 * subsystem; the auth tier a method answers to is decided by the sets in
 * src/api.js, never by which family file holds it.
 *
 ********************************************************************/

const { buildSystemRpc } = require('./system');
const { buildOracleRpc } = require('./oracle');
const { buildFeedRpc } = require('./feed');
const { buildFeedReorgRpc } = require('./feed_reorg');
const { buildValidatorsRpc } = require('./validators');
const { buildCrossChainRpc } = require('./cross_chain');
const { buildAnchorRpc } = require('./anchor');
const { buildGovernanceRpc } = require('./governance');
const { buildAttestationRpc } = require('./attestation');

const FAMILIES = [
    buildSystemRpc, buildOracleRpc, buildFeedRpc, buildFeedReorgRpc, buildValidatorsRpc,
    buildCrossChainRpc, buildAnchorRpc, buildGovernanceRpc, buildAttestationRpc,
];

// A method name two families both define is refused at boot: merged silently, the
// later family would replace the earlier handler and the router would serve it with
// nothing to say a handler had gone.
function buildRpcController(ctx) {
    const controller = {};
    for (const build of FAMILIES) {
        for (const [name, handler] of Object.entries(build(ctx))) {
            if (Object.prototype.hasOwnProperty.call(controller, name))
                throw new Error('JSON-RPC method ' + name + ' is defined by two route families');
            controller[name] = handler;
        }
    }
    return controller;
}

module.exports = { buildRpcController };
