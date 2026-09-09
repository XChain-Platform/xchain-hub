'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// A STANDALONE hub (no P2P_VALIDATOR_ADDR, so no p2pConfig) used to resolve
// `network` to '' with no way to say otherwise, and every network-keyed gate its
// INGEST path consults fails closed on '': no EQUIV wrap around the signed
// canonical (so a testnet batch's signatures verify against the wrong bytes and
// none of them count), the count quorum instead of the stake-weighted one, the
// legacy sig-tally order, and the pre-widening pair-name pattern that cannot
// express a 6-character ticker. A chain-only node pushes on-chain PRICE batches
// to its OWN standalone hub, so on testnet its mirror could never fill.
//
// api.js now validates an OPTIONAL HUB_NETWORK in standalone mode exactly as it
// validates the required one in validator mode, and hands it to the constructor.
// Unset still resolves to '', which is what every existing single-host deployment
// gets. p2pConfig === null remains the standalone-mode signal; the network string
// never carries that meaning.

const path             = require('path');
const { spawn }        = require('child_process');
const { expect }       = require('chai');

const XChainHub        = require('../../src/XChainHub');
const PriceAggregator  = require('../../src/PriceAggregator');

// The real gate modules, used here to state the expected values rather than to
// produce them: the assertions below read the aggregator's OWN behaviour.
const eq               = require('../../src/equivocation_header.js');

const API_ENTRY = path.resolve(__dirname, '../../src/api.js');

// A TBTC height above every testnet oracle activation (all of which are 0 on
// testnet) and below nothing that matters here; the row measured the gates at
// 151580 on the live chain.
const TBTC_HEIGHT = 151580;
const BLOCK_TIME  = 1789000000;

describe('XChainHub standalone network (HUB_NETWORK without P2P_VALIDATOR_ADDR)', function () {

    describe('constructor resolution', function () {

        it('takes the standalone network from opts', function () {
            const hub = new XChainHub('h', 1, 'd', 'u', 'p', null, { network: 'testnet' });
            expect(hub.network).to.equal('testnet');
        });

        it('still resolves to the empty string when no network is handed over', function () {
            expect(new XChainHub('h', 1, 'd', 'u', 'p', null).network).to.equal('');
            expect(new XChainHub('h', 1, 'd', 'u', 'p', null, {}).network).to.equal('');
            expect(new XChainHub('h', 1, 'd', 'u', 'p', null, { network: '' }).network).to.equal('');
        });

        it('lets a validator p2pConfig win over opts', function () {
            const hub = new XChainHub('h', 1, 'd', 'u', 'p',
                { HUB_NETWORK: 'mainnet' }, { network: 'testnet' });
            expect(hub.network).to.equal('mainnet');
        });

        // api.js always puts HUB_NETWORK in p2pConfig, but test doubles and the e2e
        // cluster build partial ones; the opts value is the fallback, not an override.
        it('falls back to opts when a p2pConfig carries no HUB_NETWORK', function () {
            const hub = new XChainHub('h', 1, 'd', 'u', 'p',
                { P2P_PORT: 10001 }, { network: 'regtest' });
            expect(hub.network).to.equal('regtest');
        });

        // The invariant a network string must never take over: standalone mode is
        // p2pConfig === null and nothing else.
        it('keeps p2pConfig === null as the standalone-mode signal', async function () {
            const hub = new XChainHub('h', 1, 'd', 'u', 'p', null, { network: 'testnet' });
            expect(hub.p2pConfig).to.equal(null);
            await hub.startP2P();
            expect(hub.getPeerManager()).to.equal(null);
            expect(hub.getIdentity()).to.equal(null);
            await hub.startConsensus();
            expect(hub.getConsensus()).to.equal(null);
            await hub.startOracle();
            expect(hub.getOracle()).to.equal(null);
        });
    });

    // The reason the row exists. These drive PriceAggregator's real ingest path
    // against the real activation modules; only the validator-snapshot read is
    // replaced, and only so the batch stops at a recordable point.
    describe('ingest gates on a standalone hub', function () {

        // Records which quorum mode the aggregator asked for and answers nothing, so
        // every batch below ends at 'validator snapshot unavailable' once it has got
        // that far. Shaped like CapabilitySnapshot, not like a gate.
        function snapshotRecorder() {
            const calls = [];
            return {
                calls,
                async getSnapshot(cap, block)       { calls.push(['getSnapshot', cap, block]); return null; },
                async getWeightSnapshot(cap, block) { calls.push(['getWeightSnapshot', cap, block]); return null; }
            };
        }

        function standaloneHub(network) {
            const hub = new XChainHub('h', 1, 'd', 'u', 'p', null,
                network === null ? undefined : { network });
            hub.db = { getPriceIngestWatermark: async () => null };
            hub.capabilitySnapshot = snapshotRecorder();
            return hub;
        }

        // One landed batch's push shape. `pairs` varies per test; everything else is
        // structurally valid so the run reaches the gates rather than a shape check.
        function batch(pairs) {
            return {
                first_round:      100,
                last_round:       101,
                btc_block_height: TBTC_HEIGHT,
                block_index:      6100000,
                block_time:       BLOCK_TIME,
                rounds: [
                    { round: 100, timestamp: BLOCK_TIME - 3600, btc_block_height: TBTC_HEIGHT, pairs },
                    { round: 101, timestamp: BLOCK_TIME - 1800, btc_block_height: TBTC_HEIGHT, pairs }
                ],
                sigs: [{ pubkey: 'a'.repeat(64), sig: 'b'.repeat(128) }]
            };
        }

        const PLAIN_PAIRS = [{ pair: 'BTC/USD', price: '65000.5' }];
        const WIDE_PAIRS  = [{ pair: 'XCHAIN/USD', price: '0.42' }];

        it('accepts a 6-character ticker on testnet and refuses it with no network', async function () {
            const scoped   = standaloneHub('testnet');
            const unscoped = standaloneHub(null);

            const scopedResult   = await new PriceAggregator(scoped).receiveValidatedBatch('TDOGE', batch(WIDE_PAIRS));
            const unscopedResult = await new PriceAggregator(unscoped).receiveValidatedBatch('TDOGE', batch(WIDE_PAIRS));

            // The pre-widening pattern caps the ticker at 5 characters, so the whole
            // batch dies before any signature is looked at.
            expect(unscopedResult.accepted).to.equal(false);
            expect(unscopedResult.reason).to.equal('invalid pairs');
            expect(unscoped.capabilitySnapshot.calls).to.deep.equal([]);

            // With the network known the pair passes and the batch runs on to the
            // validator set, which this test declines to supply.
            expect(scopedResult.accepted).to.equal(false);
            expect(scopedResult.reason).to.equal('validator snapshot unavailable');
        });

        it('resolves the stake-weighted quorum on testnet and the count quorum with no network', async function () {
            const scoped   = standaloneHub('testnet');
            const unscoped = standaloneHub(null);

            const scopedResult   = await new PriceAggregator(scoped).receiveValidatedBatch('TDOGE', batch(PLAIN_PAIRS));
            const unscopedResult = await new PriceAggregator(unscoped).receiveValidatedBatch('TDOGE', batch(PLAIN_PAIRS));

            // Same batch, same refusal reason: the difference is WHICH quorum rule the
            // hub asked the snapshot for, which is the rule it would have judged the
            // batch's four signatures against.
            expect(scopedResult.reason).to.equal('validator snapshot unavailable');
            expect(unscopedResult.reason).to.equal('validator snapshot unavailable');
            expect(scoped.capabilitySnapshot.calls).to.deep.equal([['getWeightSnapshot', 'price', TBTC_HEIGHT]]);
            expect(unscoped.capabilitySnapshot.calls).to.deep.equal([['getSnapshot', 'price', TBTC_HEIGHT]]);
        });

        it('wraps the per-round canonical in the EQUIV header on testnet, and not with no network', function () {
            const raw = JSON.stringify({
                round: 100, timestamp: BLOCK_TIME - 3600, btc_block_height: TBTC_HEIGHT,
                pairs: [{ pair: 'BTC/USD', price: '65000.5' }]
            });

            const scoped = new PriceAggregator(standaloneHub('testnet'))
                ._buildPriceV0Payload(100, BLOCK_TIME - 3600, PLAIN_PAIRS, TBTC_HEIGHT);
            const unscoped = new PriceAggregator(standaloneHub(null))
                ._buildPriceV0Payload(100, BLOCK_TIME - 3600, PLAIN_PAIRS, TBTC_HEIGHT);

            // These are the exact bytes a signature is verified over, so an unscoped hub
            // checks a testnet validator's signature against content it never signed.
            expect(unscoped).to.equal(raw);
            expect(scoped).to.equal(eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, TBTC_HEIGHT, 0, raw));
            expect(scoped).to.not.equal(unscoped);
        });
    });

    // api.js is the only place HUB_NETWORK is validated, so this drives the real
    // entrypoint as a subprocess rather than re-implementing the check.
    describe('api.js validates an optional HUB_NETWORK in standalone mode', function () {
        this.timeout(30000);

        // Port 1 has no listener, so a valid boot never gets past the DB into serving;
        // no P2P_VALIDATOR_ADDR, so every run below is standalone.
        const BASE_ENV = {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            HUB_DB_HOST: '127.0.0.1',
            HUB_DB_PORT: '1',
            HUB_DB_NAME: 'standalone_network_unit_dummy',
            HUB_DB_USER: 'nobody',
            HUB_DB_SECRET: 'unused',
            HUB_PORT:    '19998',
            HUB_ALLOW_UNAUTHENTICATED: 'true'
        };
        const REFUSAL = 'Invalid optional environment variable: HUB_NETWORK';

        // Ceiling, NOT a budget: nothing waits it out on a healthy run. It exists so a
        // hung boot fails in finite time, and it is named in the assertion messages so a
        // venue-speed failure cannot be misread as a gate regression.
        const BOOT_CEILING_MS = 20000;

        // Wait for a DECISIVE SIGNAL, never for a slice of wall clock. The two
        // boots-past-the-gate cases never exit on their own (a valid boot blocks on a
        // dead DB port), so a fixed spawnSync timeout WAS their exit path, and the
        // assertion then read whatever output happened to arrive before the kill. Any
        // venue slower than the budget lost the very line being asserted, and the refusal
        // case reported a null exit code, which reads as "did not refuse" and is
        // indistinguishable from a real regression. Resolving on the marker also drops
        // roughly ten seconds of deliberate dead wait from every run of this suite.
        function boot(network, marker) {
            const env = Object.assign({}, BASE_ENV);
            if (network !== null) env.HUB_NETWORK = network;
            return new Promise((resolve) => {
                const child = spawn('node', [API_ENTRY], { env });
                let output     = '';
                let markerSeen = false;
                let settled    = false;
                const finish = (status, timedOut) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(ceiling);
                    child.kill('SIGKILL');           // no-op once it has already exited
                    resolve({ status, stderr: output, markerSeen, timedOut });
                };
                const ceiling = setTimeout(() => finish(null, true), BOOT_CEILING_MS);
                const onData = (buf) => {
                    output += buf.toString();
                    if (marker && !markerSeen && output.includes(marker)) {
                        markerSeen = true;
                        finish(null, false);          // seen it; nothing left to wait for
                    }
                };
                child.stdout.on('data', onData);
                child.stderr.on('data', onData);
                child.on('error', () => finish(null, false));
                child.on('exit',  (code) => finish(code, false));
            });
        }

        it('refuses to boot on a network name that is not mainnet|testnet|regtest', async function () {
            const r = await boot('tesnet');
            // Checked before the exit code so a killed boot names itself, instead of
            // surfacing as `expected null to equal 1` and sending the reader after a
            // refusal that did in fact happen.
            expect(r.timedOut, 'api.js never exited within ' + BOOT_CEILING_MS +
                'ms, so this run measured venue speed rather than the gate').to.equal(false);
            expect(r.status).to.equal(1);
            expect(r.stderr).to.include(REFUSAL);
        });

        // "Creating <db> database" is XChainHub.start(), several steps past the gate, so
        // it says the boot got THROUGH rather than merely that no refusal was printed.
        const PAST_THE_GATE = 'Creating ' + BASE_ENV.HUB_DB_NAME + ' database';

        it('boots past the gate on a valid network name', async function () {
            const r = await boot('testnet', PAST_THE_GATE);
            expect(r.stderr).to.not.include(REFUSAL);
            expect(r.timedOut, 'boot never reached "' + PAST_THE_GATE + '" within ' +
                BOOT_CEILING_MS + 'ms').to.equal(false);
            expect(r.stderr).to.include(PAST_THE_GATE);
        });

        it('boots past the gate with HUB_NETWORK unset, as every single-host hub does', async function () {
            const r = await boot(null, PAST_THE_GATE);
            expect(r.stderr).to.not.include(REFUSAL);
            expect(r.timedOut, 'boot never reached "' + PAST_THE_GATE + '" within ' +
                BOOT_CEILING_MS + 'ms').to.equal(false);
            expect(r.stderr).to.include(PAST_THE_GATE);
        });
    });
});
