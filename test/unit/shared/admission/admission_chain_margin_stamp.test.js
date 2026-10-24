'use strict';

const { expect } = require('chai');
const proxyquire = require('proxyquire');

const ah = require('../../../../src/lib/admission_height.js');
const { AdmissionHeightWatermark } = require('../../../../src/peers/hub_db/admission_height_watermark.js');
const { activationHeight } = require('../../../../src/consensus/gates/mirror_admission_margin_gate.js');
const { AdmissionHeightWatermark: ConfiguredWatermark } = proxyquire(
    '../../../../src/peers/hub_db/admission_height_watermark.js', {
        '../../config': { '@noCallThru': true },
    });

const WINDOWS = {
    XDEX_ROUND_MAX_LIFETIME_MS:        400000,
    ATTESTATION_ROUND_TIMEOUT_MS:      100000,
    ANCHOR_ROUND_TIMEOUT_MS:           100000,
    ORACLE_ROUND_INTERVAL:             200000,
    ADMISSION_ORACLE_INGEST_WINDOW_MS: 200000,
};

describe('admission chain margin stamp', function () {
    it('stamps each chain with the margin selected for that chain and rail', function () {
        expect(ah.admitBlocks(['BTC', 'DOGE', 'LTC'], { BTC: 100, DOGE: 100, LTC: 100 },
            'bridge_transfers', 'regtest')).to.deep.equal({ BTC: 104, DOGE: 114, LTC: 114 });
        expect(ah.admitBlocks(['DOGE'], { DOGE: 100 },
            'price_snapshots', 'regtest')).to.deep.equal({ DOGE: 116 });
        expect(ah.admitBlocks(['LTC'], { LTC: 100 },
            'price_snapshots', 'regtest')).to.deep.equal({ LTC: 117 });
    });

    it('keeps the legacy LTC stamp below its testnet activation and on mainnet', function () {
        // Shipped on the UNARMED sentinel; a cut replaces it with a sized height.
        const activation = activationHeight('LTC', 'testnet');
        expect(activation).to.be.within(4900001, 9999999999);
        expect(activationHeight('LTC', 'mainnet')).to.equal(null);
        expect(ah.admitBlocks(['LTC'], { LTC: activation - 18 },
            'bridge_transfers', 'testnet')).to.deep.equal({ LTC: activation - 14 });
        expect(ah.admitBlocks(['LTC'], { LTC: activation - 18 },
            'price_snapshots', 'testnet')).to.deep.equal({ LTC: activation - 14 });
        expect(ah.admitBlocks(['LTC'], { LTC: 3000000 },
            'bridge_transfers', 'mainnet')).to.deep.equal({ LTC: 3000004 });
    });

    it('switches margins only when the stamped height reaches the activation', function () {
        const activation = activationHeight('DOGE', 'testnet');
        expect(ah.admitBlocks(['DOGE'], { DOGE: activation - 15 },
            'bridge_transfers', 'testnet')).to.deep.equal({ DOGE: activation - 11 });
        expect(ah.admitBlocks(['DOGE'], { DOGE: activation - 14 },
            'bridge_transfers', 'testnet')).to.deep.equal({ DOGE: activation });
    });

    it('uses the stamped row era when checking a late finalization', function () {
        const activation = activationHeight('DOGE', 'testnet');
        const w = new ConfiguredWatermark(Object.assign({ HUB_NETWORK: 'testnet' }, WINDOWS));
        w.setFloor({ bridge_transfers: { DOGE: activation - 10 } });

        expect(w.isLateFinalization('bridge_transfers',
            { admit_block_doge: activation - 1 }, 0)).to.equal(null);
        expect(w.isLateFinalization('bridge_transfers',
            { admit_block_doge: activation }, 0)).to.deep.include({
                chain: 'DOGE', reason: 'round abandoned', watermark: activation - 10,
                admitBlock: activation,
            });
    });

    it('uses the activated DOGE margin at the late-finalization boundary', function () {
        const w = new AdmissionHeightWatermark(Object.assign({ HUB_NETWORK: 'regtest' }, WINDOWS));
        w.observeTip('DOGE', 101, 0);

        expect(w.isLateFinalization('bridge_transfers',
            { admit_block_doge: 110 }, 600000)).to.deep.include({
                chain: 'DOGE', reason: 'round abandoned', watermark: 100, admitBlock: 110,
            });
        expect(w.isLateFinalization('bridge_transfers',
            { admit_block_doge: 115 }, 600000)).to.equal(null);
    });
});
