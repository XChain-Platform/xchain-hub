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
 **********************************************************************/

'use strict';

const { expect } = require('chai');

const ADMIT_AT   = 1000;
const ERA_BLOCK  = 2000;
const LEGACY_BLK = 150;

const ARMED_MODULES = [
    '../../../../src/consensus/gates/mirror_admission_gate.js',
    '../../../../src/lib/admission_height.js',
    '../../../../src/cross_chain/dex_engine.js',
    '../../../../src/cross_chain/bridge_engine.js'
];

function armAdmission(){
    const paths    = ARMED_MODULES.map(m => require.resolve(m));
    const saved    = paths.map(p => [p, require.cache[p]]);
    const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    for(const p of paths) delete require.cache[p];
    process.env.XC_MIRROR_ADMISSION_ACTIVATION = String(ADMIT_AT);

    const ah                       = require('../../../../src/lib/admission_height.js');
    const CrossChainDexEngine      = require('../../../../src/cross_chain/dex_engine.js');
    const CrossChainBridgeEngine   = require('../../../../src/cross_chain/bridge_engine.js');

    function restore(){
        for(const [p, mod] of saved){
            if(mod === undefined) delete require.cache[p];
            else require.cache[p] = mod;
        }
        if(savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
    }
    return { ah, CrossChainDexEngine, CrossChainBridgeEngine, restore };
}

let armed;
let dex;
let bridge;

function setupAdmissionScopes(){
    armed  = armAdmission();
    dex    = Object.create(armed.CrossChainDexEngine.prototype);
    bridge = Object.create(armed.CrossChainBridgeEngine.prototype);
}

function restoreAdmissionScopes(){
    armed.restore();
}

function verifyLegacyRowsReturnNull(){
    expect(dex.admissionScope({
        network: 'regtest', snapshot_block: LEGACY_BLK,
        a_chain: 'BTC', b_chain: 'DOGE'
    })).to.equal(null);
    expect(bridge.admissionScope({
        network: 'regtest', snapshot_block: LEGACY_BLK,
        transfer_id: 'transfer', dest_chain: 'LTC'
    })).to.equal(null);
    expect(bridge.admissionScope({
        network: 'regtest', snapshot_block: LEGACY_BLK,
        snapshot_id: 'policy'
    })).to.equal(null);
}

function verifyDexMatchScope(){
    expect(dex.admissionScope({
        network: 'regtest', snapshot_block: ERA_BLOCK,
        a_chain: 'DOGE', b_chain: 'BTC'
    })).to.deep.equal({
        table: 'cross_chain_matches',
        readSet: ['BTC', 'DOGE']
    });
}

function verifyBridgeTransferScope(){
    expect(bridge.admissionScope({
        network: 'regtest', snapshot_block: ERA_BLOCK,
        transfer_id: 'transfer', dest_chain: 'LTC'
    })).to.deep.equal({
        table: 'bridge_transfers',
        readSet: ['LTC']
    });
}

function verifyPolicySnapshotScope(){
    const scope = bridge.admissionScope({
        network: 'regtest', snapshot_block: ERA_BLOCK,
        snapshot_id: 'policy'
    });
    expect(scope).to.deep.equal({
        table: 'policy_snapshots',
        readSet: armed.ah.ADMIT_COLUMN_CHAINS.slice().sort()
    });
    expect(scope.readSet).to.have.length(armed.ah.ADMIT_COLUMN_CHAINS.length);
}

function verifyMissingBridgeDiscriminatorRejected(){
    expect(() => bridge.admissionScope({
        network: 'regtest', snapshot_block: ERA_BLOCK, dest_chain: 'BTC'
    })).to.throw('exactly one of transfer_id / snapshot_id');
}

function verifyBothBridgeDiscriminatorsRejected(){
    expect(() => bridge.admissionScope({
        network: 'regtest', snapshot_block: ERA_BLOCK,
        transfer_id: 'transfer', snapshot_id: 'policy', dest_chain: 'BTC'
    })).to.throw('exactly one of transfer_id / snapshot_id');
}

function verifyLegacyBridgeDiscriminatorsIgnored(){
    expect(bridge.admissionScope({
        network: 'regtest', snapshot_block: LEGACY_BLK,
        transfer_id: 'transfer', snapshot_id: 'policy'
    })).to.equal(null);
    expect(bridge.admissionScope({
        network: 'regtest', snapshot_block: LEGACY_BLK
    })).to.equal(null);
}

describe('cross-chain engine follower admission scopes', function(){
    before(setupAdmissionScopes);
    after(restoreAdmissionScopes);

    it('returns null for legacy DEX and bridge rows', verifyLegacyRowsReturnNull);
    it('scopes DEX matches to cross_chain_matches and both reading chains', verifyDexMatchScope);
    it('scopes bridge transfers to bridge_transfers and the destination chain', verifyBridgeTransferScope);
    it('scopes policy snapshots to every admission-column chain', verifyPolicySnapshotScope);
    it('rejects admission-era bridge rows with neither discriminator', verifyMissingBridgeDiscriminatorRejected);
    it('rejects admission-era bridge rows with both discriminators', verifyBothBridgeDiscriminatorsRejected);
    it('does not inspect malformed bridge discriminators before activation', verifyLegacyBridgeDiscriminatorsIgnored);
});
