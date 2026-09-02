'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// getallconfigs credential redaction (src/lib/config_redaction.js).
//
// The hub's configs table holds real credentials: xchain-node writes the coin
// node's rpc user/pass and the indexer/decoder/checkpoint DB user/pass into it
// (SERVICE_REGISTRY hubConfig fields). getallconfigs served that tree verbatim,
// so every operational read copied plaintext passwords out of the database.
// These cases pin what may leave the hub without an authorized include_secrets.

const { expect } = require('chai');
const redaction  = require('../../src/lib/config_redaction.js');

// The shape xchain-node actually pushes (HubService.buildHubModuleConfig /
// buildCheckpointConfig), so the assertions below are about real params rather
// than an invented tree.
function realisticTree() {
    return {
        Bitcoin: {
            regtest: {
                bitcoind: {
                    host: 'bitcoin-node', port: '18443', server_port: '18443',
                    user: 'rpcuser', pass: 'node-rpc-secret'
                },
                'xchain-indexer': {
                    host: 'indexer', port: '3000', server_port: '3000',
                    db_host: 'mariadb', db_port: '3306', name: 'XCHAIN_BTC_REGTEST',
                    user: 'indexer_user', pass: 'indexer-db-secret'
                },
                'xchain-decoder': {
                    db_host: 'mariadb', db_port: '3306', name: 'DECODER_BTC_REGTEST',
                    user: 'decoder_user', pass: 'decoder-db-secret'
                },
                checkpoint: {
                    hub_url: 'http://hub:10000', db_host: 'mariadb', db_port: '3306',
                    user: 'indexer_user', pass: 'indexer-db-secret',
                    name: 'XCHAIN_BTC_REGTEST_HubMirror', self_sync: 'true'
                },
                chain_tips: { block_height: '4211', block_time: '1788121413' }
            }
        }
    };
}

describe('config_redaction', function () {

    describe('isSecretParamName', function () {

        it('matches the credential params xchain-node actually pushes', function () {
            for (const name of ['pass', 'password', 'db_pass', 'rpc_password', 'NODE_PASSWORD',
                               'api_key', 'apikey', 'HUB_API_KEY', 'secret', 'HUB_DB_SECRET',
                               'token', 'privkey', 'private_key', 'signing_privkey_hex',
                               'mnemonic', 'seed', 'wif', 'credential', 'authorization'])
                expect(redaction.isSecretParamName(name)).to.equal(true, name + ' must be treated as secret');
        });

        it('leaves the connection params consumers legitimately need', function () {
            for (const name of ['host', 'port', 'server_port', 'db_host', 'db_port', 'name',
                                'user', 'hub_url', 'self_sync', 'block_height', 'block_time',
                                'signing_pubkey', 'addr', 'network', 'coin'])
                expect(redaction.isSecretParamName(name)).to.equal(false, name + ' must NOT be redacted');
        });

        it('tolerates non-string names instead of throwing', function () {
            for (const name of [undefined, null, 0, 42, {}])
                expect(redaction.isSecretParamName(name)).to.equal(false);
        });
    });

    describe('wantsSecrets', function () {

        it('is true only for an explicit opt-in', function () {
            for (const v of [true, 1, '1', 'true', 'TRUE', 'True'])
                expect(redaction.wantsSecrets(v)).to.equal(true, JSON.stringify(v));
        });

        it('defaults to redaction for anything else, including near-misses', function () {
            for (const v of [undefined, null, false, 0, '0', '', 'yes', 'false', {}, []])
                expect(redaction.wantsSecrets(v)).to.equal(false, JSON.stringify(v));
        });
    });

    describe('redactConfigTree', function () {

        it('replaces every password in a realistic node-pushed tree', function () {
            const { configs, redacted } = redaction.redactConfigTree(realisticTree());
            const btc = configs.Bitcoin.regtest;
            expect(btc.bitcoind.pass).to.equal(redaction.REDACTED);
            expect(btc['xchain-indexer'].pass).to.equal(redaction.REDACTED);
            expect(btc['xchain-decoder'].pass).to.equal(redaction.REDACTED);
            expect(btc.checkpoint.pass).to.equal(redaction.REDACTED);
            expect(redacted).to.equal(4);
        });

        it('serves every non-secret param unchanged, so discovery still works', function () {
            const { configs } = redaction.redactConfigTree(realisticTree());
            const btc = configs.Bitcoin.regtest;
            expect(btc['xchain-indexer'].db_host).to.equal('mariadb');
            expect(btc['xchain-indexer'].db_port).to.equal('3306');
            expect(btc['xchain-indexer'].name).to.equal('XCHAIN_BTC_REGTEST');
            expect(btc['xchain-indexer'].user).to.equal('indexer_user');
            expect(btc.checkpoint.hub_url).to.equal('http://hub:10000');
            expect(btc.checkpoint.self_sync).to.equal('true');
            expect(btc.chain_tips.block_height).to.equal('4211');
        });

        it('never mutates the caller\'s tree (the hub reads the same object internally)', function () {
            const original = realisticTree();
            redaction.redactConfigTree(original);
            expect(original.Bitcoin.regtest['xchain-indexer'].pass).to.equal('indexer-db-secret');
            expect(original.Bitcoin.regtest.bitcoind.pass).to.equal('node-rpc-secret');
        });

        it('redacts a credential nested inside a JSON-blob param value', function () {
            const tree = { Bitcoin: { regtest: { ATTESTATION_PROVIDER: {
                llm: JSON.stringify({ judge_models: ['a', 'b'], vendors: { anthropic: { api_key: 'sk-live-xyz' } } })
            } } } };
            const { configs, redacted } = redaction.redactConfigTree(tree);
            const blob = JSON.parse(configs.Bitcoin.regtest.ATTESTATION_PROVIDER.llm);
            expect(blob.vendors.anthropic.api_key).to.equal(redaction.REDACTED);
            expect(blob.judge_models).to.deep.equal(['a', 'b']);
            expect(redacted).to.equal(1);
        });

        it('leaves a clean JSON blob byte-identical rather than re-serializing it', function () {
            const raw  = '{ "judge_models" : ["a","b"],  "threshold": 0.85 }';
            const tree = { Bitcoin: { regtest: { ATTESTATION_PROVIDER: { llm: raw } } } };
            const { configs, redacted } = redaction.redactConfigTree(tree);
            expect(configs.Bitcoin.regtest.ATTESTATION_PROVIDER.llm).to.equal(raw);
            expect(redacted).to.equal(0);
        });

        it('leaves a value that only looks like JSON alone', function () {
            const tree = { Bitcoin: { regtest: { m: { note: '{not json at all', url: 'http://x/y' } } } };
            const { configs, redacted } = redaction.redactConfigTree(tree);
            expect(configs.Bitcoin.regtest.m.note).to.equal('{not json at all');
            expect(configs.Bitcoin.regtest.m.url).to.equal('http://x/y');
            expect(redacted).to.equal(0);
        });

        it('reports zero for a tree carrying no credential', function () {
            const tree = { Bitcoin: { regtest: { chain_tips: { block_height: '9', block_time: '1' } } } };
            expect(redaction.redactConfigTree(tree).redacted).to.equal(0);
        });

        it('handles empty, null and non-object inputs without throwing', function () {
            expect(redaction.redactConfigTree({})).to.deep.equal({ configs: {}, redacted: 0 });
            expect(redaction.redactConfigTree(null)).to.deep.equal({ configs: null, redacted: 0 });
            expect(redaction.redactConfigTree(undefined).configs).to.equal(undefined);
        });

        it('survives a self-referential tree, and fails closed at the depth cap', function () {
            const tree = { Bitcoin: { regtest: { m: { pass: 'cycle-secret-value' } } } };
            tree.Bitcoin.regtest.m.self = tree;
            const { configs, redacted } = redaction.redactConfigTree(tree);
            expect(configs.Bitcoin.regtest.m.pass).to.equal(redaction.REDACTED);
            expect(redacted).to.be.greaterThan(0);
            // The output must terminate (no cycle handed back) and must not carry
            // the real password ANYWHERE: returning the original node at the depth
            // cap would splice the whole unredacted graph back into the response.
            const serialized = JSON.stringify(configs);
            expect(serialized).to.not.include('cycle-secret-value');
            expect(serialized).to.include(redaction.TRUNCATED);
        });
    });
});
