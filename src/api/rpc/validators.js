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
 * XChain Hub - JSON-RPC validator family: registration, rotation, sync and the
 * validator and capability reads.
 *
 ********************************************************************/

const { validateLimit } = require('../validate');

function buildValidatorsRpc(ctx) {
    return Object.assign({}, validatorWritesRpc(ctx), validatorReadsRpc(ctx));
}

function validatorWritesRpc(ctx) {
    const { hub } = ctx;
    return {
        async registervalidator({signing_pubkey, addr}){
            try {
                await hub.registerValidator(signing_pubkey, addr);
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "there was an error trying to register a validator"};
            }
        },

        async rotatevalidator({addr, new_signing_pubkey}){
            try {
                await hub.rotateValidator(addr, new_signing_pubkey);
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "there was an error trying to rotate a validator"};
            }
        },

        async deregistervalidator({signing_pubkey, addr}){
            try {
                await hub.deregisterValidator({signingPubkey: signing_pubkey, addr});
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "there was an error trying to deregister a validator"};
            }
        },

        async syncvalidators({validators}){
            try {
                await hub.syncValidators(validators);
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "error syncing validators"};
            }
        },
    };
}

function validatorReadsRpc(ctx) {
    const { hub } = ctx;
    return {
        async getvalidators(){
            try {
                return await hub.getValidators();
            } catch (err) {
                return {error: "error fetching validators"};
            }
        },

        async getvalidatorstatus({signing_pubkey}){
            if(!signing_pubkey) return {error: "signing_pubkey is required"};
            try {
                let status = await hub.getValidatorStatus(signing_pubkey);
                return status || {error: "validator not found"};
            } catch (err) {
                return {error: "error fetching validator status"};
            }
        },

        // List per-validator capability qualification rows, optionally filtered by
        // pubkey and/or capability. Read-only companion to getcapabilitythresholds:
        // thresholds say what a capability requires, this says who currently holds it.
        async getvalidatorcapabilities({signing_pubkey, capability, limit}){
            let limErr = validateLimit(limit);
            if (limErr) return limErr;
            if(!hub.capabilityRegistry) return {error: "capability registry not active"};
            try {
                return await hub.getValidatorCapabilities({signingPubkey: signing_pubkey, capability, limit});
            } catch (err) {
                return {error: "error fetching validator capabilities"};
            }
        },
    };
}

module.exports = { buildValidatorsRpc };
