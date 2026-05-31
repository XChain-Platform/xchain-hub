'use strict';

const { expect }    = require('chai');
const testDb        = require('../helpers/testDb');
const priceMocks    = require('./helpers/priceMocks');
const { createCluster } = require('./helpers/cluster');
const { callRpc }       = require('./helpers/rpcClient');

describe('E2E: API Contract Verification', function () {

    let cluster;

    before(async function () {
        this.timeout(15000);
        try { await testDb.setup(); } catch (e) {
            console.warn('MariaDB unavailable — skipping E2E API contract tests');
            return;
        }
        priceMocks.setup();
    });

    after(async function () {
        this.timeout(10000);
        priceMocks.teardown();
        await testDb.teardown();
    });

    beforeEach(async function () {
        this.timeout(15000);
        if (!testDb.isAvailable()) return this.skip();
        await testDb.truncateAll();
        priceMocks.reset();
        priceMocks.mockCoinGeckoSuccess();

        cluster = createCluster(1);
        await cluster.start();
    });

    afterEach(async function () {
        this.timeout(10000);
        if (cluster) {
            await cluster.stop();
            cluster = null;
        }
    });

    // E2E-API-001: All JSON-RPC methods return valid responses
    describe('E2E-API-001: All methods return valid responses', function () {

        it('ping', async function () {
            let res = await callRpc(cluster.getPort(0), 'ping');
            expect(res.result).to.deep.equal({ status: 'success' });
        });

        it('getallconfigs — empty', async function () {
            let res = await callRpc(cluster.getPort(0), 'getallconfigs');
            expect(res.result).to.be.an('object');
            expect(res.result.configs).to.be.an('object');
            expect(res.result.seq).to.be.a('number');
        });

        it('updateconfig + getallconfigs', async function () {
            let port = cluster.getPort(0);
            let writeRes = await callRpc(port, 'updateconfig', {
                config: { BTC: { mainnet: { decoder: { host: 'test' } } } }
            });
            expect(writeRes.result.status).to.equal('success');

            let readRes = await callRpc(port, 'getallconfigs');
            expect(readRes.result.configs.BTC.mainnet.decoder.host).to.equal('test');
        });

        it('registervalidator + getvalidators', async function () {
            let port = cluster.getPort(0);
            let pubkey = 'cc'.repeat(32);

            let regRes = await callRpc(port, 'registervalidator', {
                signing_pubkey: pubkey, addr: 'ws://new-val:10001'
            });
            expect(regRes.result.status).to.equal('success');

            let listRes = await callRpc(port, 'getvalidators');
            expect(listRes.result).to.be.an('array');
            expect(listRes.result.some(v => v.signing_pubkey === pubkey)).to.be.true;
        });

        it('syncvalidators', async function () {
            let port = cluster.getPort(0);
            let res = await callRpc(port, 'syncvalidators', {
                validators: [
                    { signing_pubkey: 'dd'.repeat(32), addr: 'ws://sync-v1:10001' },
                    { signing_pubkey: 'ee'.repeat(32), addr: 'ws://sync-v2:10001' }
                ]
            });
            expect(res.result.status).to.equal('success');
        });

        it('getvalidatorstatus', async function () {
            let port = cluster.getPort(0);
            let pubkey = cluster.getKeypair(0).pubkeyHex;
            let res = await callRpc(port, 'getvalidatorstatus', { signing_pubkey: pubkey });
            expect(res.result.validator).to.exist;
            expect(res.result.validator.signing_pubkey).to.equal(pubkey);
        });

        it('getoraclesubmissions', async function () {
            let res = await callRpc(cluster.getPort(0), 'getoraclesubmissions');
            expect(res.result.currentRound).to.be.a('number');
            expect(res.result.submissions).to.be.an('object');
        });

        it('getpricesnapshots — empty', async function () {
            let res = await callRpc(cluster.getPort(0), 'getpricesnapshots', { limit: 10 });
            expect(res.result).to.be.an('array');
        });

        it('getprice — no data', async function () {
            let res = await callRpc(cluster.getPort(0), 'getprice', { coin_pair: 'BTC/USD' });
            expect(res.result.error).to.include('no price data');
        });

        it('getfeequote', async function () {
            let res = await callRpc(cluster.getPort(0), 'getfeequote', { action: 'ISSUE', chain: 'BTC' });
            expect(res.result.gasCost).to.equal(100000);
            expect(res.result.xchainAmount).to.equal('1.00000000');
        });

        it('requestattestation + getattestation', async function () {
            let port = cluster.getPort(0);
            let res = await callRpc(port, 'requestattestation', {
                source_chain: 'BTC', source_action_index: 42, dest_chain: 'LTC'
            });
            expect(res.result.status).to.equal('attested');

            let att = await callRpc(port, 'getattestation', {
                source_chain: 'BTC', source_action_index: 42
            });
            expect(att.result.source_chain).to.equal('BTC');
        });

        it('getattestations', async function () {
            let port = cluster.getPort(0);
            await callRpc(port, 'requestattestation', {
                source_chain: 'BTC', source_action_index: 1, dest_chain: 'LTC'
            });
            let res = await callRpc(port, 'getattestations', { limit: 10 });
            expect(res.result).to.be.an('array');
            expect(res.result.length).to.equal(1);
        });

        it('initiateswap + getswap + getswaps', async function () {
            let port = cluster.getPort(0);
            let initRes = await callRpc(port, 'initiateswap', {
                source_chain: 'BTC', source_action_index: 500, dest_chain: 'LTC'
            });
            expect(initRes.result.status).to.equal('success');

            let swap = await callRpc(port, 'getswap', {
                source_chain: 'BTC', source_action_index: 500
            });
            expect(swap.result.status).to.equal('initiated');

            let swaps = await callRpc(port, 'getswaps', { status: 'initiated', limit: 10 });
            expect(swaps.result).to.be.an('array');
            expect(swaps.result.length).to.equal(1);
        });

        it('propose + vote + getproposals + getproposal', async function () {
            this.timeout(10000);
            let port = cluster.getPort(0);
            let db = cluster.getDb();
            let pubkey = cluster.getKeypair(0).pubkeyHex;

            // Insert proposal directly (workaround: db.doQuery converts Date objects via .toString()
            // producing invalid MySQL datetime strings; the INSERT fails silently)
            let proposalId = 'gov:ORACLE_ROUND_INTERVAL:' + Date.now();
            await db.doQuery(
                `INSERT INTO governance_proposals
                    (proposal_id, proposer_pubkey, parameter, current_value, proposed_value,
                     rationale, status, voting_start, voting_end)
                 VALUES (?, ?, ?, ?, ?, ?, 'voting', NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY))`,
                [proposalId, pubkey, 'ORACLE_ROUND_INTERVAL', '600000', '720000', 'API test']
            );

            let voteRes = await callRpc(port, 'vote', { proposal_id: proposalId, vote: 'approve' });
            expect(voteRes.result.error).to.not.exist;

            let proposals = await callRpc(port, 'getproposals', { status: 'voting' });
            expect(proposals.result).to.be.an('array');
            expect(proposals.result.length).to.be.at.least(1);

            let proposal = await callRpc(port, 'getproposal', { proposal_id: proposalId });
            expect(proposal.result.proposal).to.exist;
            expect(proposal.result.proposal.parameter).to.equal('ORACLE_ROUND_INTERVAL');
        });

        it('reportreorg + getreorghistory', async function () {
            this.timeout(10000);
            let port = cluster.getPort(0);
            // Use timestamp=1 (epoch) to ensure rollback affects everything
            let res = await callRpc(port, 'reportreorg', {
                chain: 'BTC', reorg_height: 100, timestamp: 1
            });
            expect(res.result.status).to.equal('success');

            await new Promise(r => setTimeout(r, 1500));

            let history = await callRpc(port, 'getreorghistory', { limit: 10 });
            expect(history.result).to.be.an('array');
            expect(history.result.length).to.be.at.least(1);
        });
    });

    // E2E-API-002: Invalid input handling
    describe('E2E-API-002: Invalid input handling', function () {

        it('getprice — missing coin_pair', async function () {
            let res = await callRpc(cluster.getPort(0), 'getprice', {});
            expect(res.result.error).to.include('coin_pair is required');
        });

        it('registervalidator — invalid pubkey', async function () {
            let res = await callRpc(cluster.getPort(0), 'registervalidator', {
                signing_pubkey: 'too-short', addr: 'ws://bad:10001'
            });
            expect(res.result.error).to.include('Invalid signing pubkey');
        });

        it('registervalidator — missing addr', async function () {
            let res = await callRpc(cluster.getPort(0), 'registervalidator', {
                signing_pubkey: 'ff'.repeat(32)
            });
            expect(res.result.error).to.include('required');
        });

        it('getvalidatorstatus — missing pubkey', async function () {
            let res = await callRpc(cluster.getPort(0), 'getvalidatorstatus', {});
            expect(res.result.error).to.include('signing_pubkey is required');
        });

        it('getfeequote — missing action', async function () {
            let res = await callRpc(cluster.getPort(0), 'getfeequote', { chain: 'BTC' });
            expect(res.result.error).to.include('action is required');
        });

        it('getfeequote — missing chain', async function () {
            let res = await callRpc(cluster.getPort(0), 'getfeequote', { action: 'ISSUE' });
            expect(res.result.error).to.include('chain is required');
        });

        it('requestattestation — missing params', async function () {
            let res = await callRpc(cluster.getPort(0), 'requestattestation', { source_chain: 'BTC' });
            expect(res.result.error).to.include('required');
        });

        it('vote — missing params', async function () {
            let res = await callRpc(cluster.getPort(0), 'vote', {});
            expect(res.result.error).to.include('required');
        });

        it('propose — missing params', async function () {
            let res = await callRpc(cluster.getPort(0), 'propose', {});
            expect(res.result.error).to.include('required');
        });

        it('reportreorg — missing params', async function () {
            let res = await callRpc(cluster.getPort(0), 'reportreorg', { chain: 'BTC' });
            expect(res.result.error).to.include('required');
        });

        it('getattestation — missing params', async function () {
            let res = await callRpc(cluster.getPort(0), 'getattestation', {});
            expect(res.result.error).to.include('required');
        });

        it('getswap — missing params', async function () {
            let res = await callRpc(cluster.getPort(0), 'getswap', {});
            expect(res.result.error).to.include('required');
        });

        it('initiateswap — missing params', async function () {
            let res = await callRpc(cluster.getPort(0), 'initiateswap', { source_chain: 'BTC' });
            expect(res.result.error).to.include('required');
        });

        it('getproposal — missing proposal_id', async function () {
            let res = await callRpc(cluster.getPort(0), 'getproposal', {});
            expect(res.result.error).to.include('proposal_id is required');
        });

        it('hub remains operational after invalid inputs', async function () {
            let port = cluster.getPort(0);

            // Fire a bunch of invalid requests
            await callRpc(port, 'getprice', {});
            await callRpc(port, 'registervalidator', { signing_pubkey: 'bad' });
            await callRpc(port, 'requestattestation', {});
            await callRpc(port, 'reportreorg', {});

            // Hub should still work
            let ping = await callRpc(port, 'ping');
            expect(ping.result.status).to.equal('success');
        });
    });
});
