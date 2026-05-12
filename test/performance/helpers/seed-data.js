'use strict';

/**
 * Seed the test database with realistic hub data.
 *
 * Requires a Database instance (from testDb.getDb()).
 * All functions are idempotent — safe to call multiple times.
 */

const { makeValidator, SAMPLE_PRICES } = require('../../helpers/fixtures');

// ─── Validators ─────────────────────────────────────────────────────

/**
 * Insert N validators.
 * @param {object} db - Database instance
 * @param {number} count - number of validators (default 10)
 */
async function seedValidators(db, count) {
    count = count || 10;
    for (let i = 1; i <= count; i++) {
        let v = makeValidator(i);
        await db.doQuery(
            'INSERT IGNORE INTO validators (signing_pubkey, addr, status) VALUES (?, ?, ?)',
            [v.pubkey, v.addr, 'active']
        );
    }
}

// ─── Price Snapshots ────────────────────────────────────────────────

/**
 * Insert N rounds of price snapshots (3 coin pairs per round).
 * @param {object} db - Database instance
 * @param {number} rounds - number of rounds (default 100)
 */
async function seedPriceSnapshots(db, rounds) {
    rounds = rounds || 100;
    let baseTime = Date.now() - rounds * 600000;
    for (let r = 1; r <= rounds; r++) {
        let ts = new Date(baseTime + r * 600000).toISOString().slice(0, 19).replace('T', ' ');
        for (let p of SAMPLE_PRICES) {
            // Vary price slightly per round for realism
            let jitter = 1 + (Math.random() - 0.5) * 0.01;
            let price  = (parseFloat(p.price) * jitter).toFixed(8);
            await db.doQuery(
                `INSERT IGNORE INTO price_snapshots
                    (round_number, coin_pair, price, sources, validator_count, consensus_proof, status, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'finalized', ?)`,
                [r, p.coinPair, price, p.sources, 3, '{}', ts]
            );
        }
    }
}

// ─── Oracle Submissions ─────────────────────────────────────────────

/**
 * Insert oracle submissions for N rounds with M validators.
 * @param {object} db - Database instance
 * @param {number} rounds - number of rounds (default 10)
 * @param {number} validatorCount - validators per round (default 5)
 */
async function seedOracleSubmissions(db, rounds, validatorCount) {
    rounds         = rounds || 10;
    validatorCount = validatorCount || 5;
    let baseRound  = 1000;
    for (let r = 0; r < rounds; r++) {
        let round = baseRound + r;
        for (let v = 1; v <= validatorCount; v++) {
            let val = makeValidator(v);
            for (let p of SAMPLE_PRICES) {
                let jitter = 1 + (Math.random() - 0.5) * 0.02;
                let price  = (parseFloat(p.price) * jitter).toFixed(8);
                await db.doQuery(
                    `INSERT IGNORE INTO oracle_submissions
                        (round, coin_pair, validator_pubkey, price, sources, submitted_at)
                     VALUES (?, ?, ?, ?, ?, NOW())`,
                    [round, p.coinPair, val.pubkey, price, p.sources]
                );
            }
        }
    }
}

// ─── Configs ────────────────────────────────────────────────────────

/**
 * Insert a set of config parameters.
 * @param {object} db - Database instance
 */
async function seedConfigs(db) {
    let params = [
        ['BTC', 'mainnet', 'decoder', 'start_block', '800000'],
        ['BTC', 'mainnet', 'decoder', 'node_url', 'http://btc-node:8332'],
        ['BTC', 'mainnet', 'indexer', 'start_block', '800000'],
        ['LTC', 'mainnet', 'decoder', 'start_block', '2600000'],
        ['LTC', 'mainnet', 'decoder', 'node_url', 'http://ltc-node:9332'],
        ['LTC', 'mainnet', 'indexer', 'start_block', '2600000'],
        ['DOGE', 'mainnet', 'decoder', 'start_block', '5000000'],
        ['DOGE', 'mainnet', 'decoder', 'node_url', 'http://doge-node:22555'],
        ['DOGE', 'mainnet', 'indexer', 'start_block', '5000000'],
        ['BTC', 'testnet', 'decoder', 'start_block', '2500000'],
        ['BTC', 'regtest', 'decoder', 'start_block', '1']
    ];
    for (let p of params) {
        await db.doQuery(
            'INSERT IGNORE INTO configs (coin, network, module, param_name, param_value) VALUES (?, ?, ?, ?, ?)',
            p
        );
    }
}

// ─── Attestations ───────────────────────────────────────────────────

/**
 * Insert N attestation records.
 * @param {object} db - Database instance
 * @param {number} count - number of attestations (default 50)
 */
async function seedAttestations(db, count) {
    count = count || 50;
    let chains   = ['BTC', 'LTC', 'DOGE'];
    let statuses = ['pending', 'confirmed', 'confirmed', 'confirmed', 'failed'];
    for (let i = 1; i <= count; i++) {
        let srcChain = chains[i % chains.length];
        let dstChain = chains[(i + 1) % chains.length];
        let status   = statuses[i % statuses.length];
        await db.doQuery(
            `INSERT IGNORE INTO attestations
                (attestation_id, source_chain, source_action_index, dest_chain, status, created_at)
             VALUES (?, ?, ?, ?, ?, NOW())`,
            ['att-' + i, srcChain, i * 100, dstChain, status]
        );
    }
}

// ─── Governance Proposals ───────────────────────────────────────────

/**
 * Insert N governance proposals.
 * @param {object} db - Database instance
 * @param {number} count - number of proposals (default 10)
 */
async function seedProposals(db, count) {
    count = count || 10;
    for (let i = 1; i <= count; i++) {
        let status = i <= 3 ? 'active' : (i <= 7 ? 'approved' : 'rejected');
        await db.doQuery(
            `INSERT IGNORE INTO governance_proposals
                (proposal_id, parameter, current_value, proposed_value, rationale, proposer_pubkey, status, voting_ends_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY), NOW())`,
            ['prop-' + i, 'param_' + i, String(i), String(i * 2), 'test rationale', makeValidator(1).pubkey, status]
        );
    }
}

// ─── Master Seeder ──────────────────────────────────────────────────

/**
 * Seed all tables with realistic data.
 * @param {object} db - Database instance
 * @param {object} opts - { validators, priceRounds, submissionRounds, attestations, proposals }
 */
async function seedAll(db, opts) {
    opts = opts || {};
    await seedValidators(db, opts.validators || 10);
    await seedPriceSnapshots(db, opts.priceRounds || 100);
    await seedOracleSubmissions(db, opts.submissionRounds || 10, opts.submissionValidators || 5);
    await seedConfigs(db);
    await seedAttestations(db, opts.attestations || 50);
    await seedProposals(db, opts.proposals || 10);
}

module.exports = {
    seedValidators,
    seedPriceSnapshots,
    seedOracleSubmissions,
    seedConfigs,
    seedAttestations,
    seedProposals,
    seedAll
};
