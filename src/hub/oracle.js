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
 * XChain Hub - Oracle Bring-Up
 *
 * The price-oracle subsystem: the round engine and its consensus, the reward
 * and slash handling a finalized round drives, and the two publishers that
 * put a finalized round on chain.
 *
 ********************************************************************/

const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();

// The on-chain half of the oracle: the batch signer that produces a PRICE
// batch's one quorum signature set, and the publisher that spends for it.
async function startOraclePublishing(hub, modules) {
    const { OracleBatchSigner, OraclePublisher, loadSignerHooks, applySignerHooks } = modules;
    // Produces the ONE quorum signature set a PRICE batch's wire carries
    // (spec section 6). Modeled on StateAnchorPublisher: peer-message wiring is
    // a no-op with no peerManager, so construction never throws or blocks a
    // standalone hub, and it must exist before oraclePublisher below, whose
    // window scheduler calls collectBatchSignatures() on it.
    hub.oracleBatchSigner = new OracleBatchSigner(hub);
    await hub.oracleBatchSigner.start();

    // Subscribes to round:finalized and queues finalized rounds for DOGE publishing.
    // Inert until the operator wires a transport through setBroadcastHook() and
    // setBalanceHook().
    hub.oraclePublisher = new OraclePublisher(hub);
    // The single wiring point for ALL on-chain DOGE publishing by the operator-supplied
    // HUB_SIGNER_MODULE: StateAnchorPublisher borrows these hooks via resolveSigner().
    // Throws on a broken module.
    //
    // Every applySignerHooks call below names the rail its publisher settles on.
    // The operator signer holds ONE key; the loader refuses to wire it into a
    // publisher whose chain the module does not declare.
    let signerHooks = loadSignerHooks();
    if(signerHooks && applySignerHooks(hub.oraclePublisher, signerHooks, 'DOGE')){
        logger.info('OraclePublisher: operator signer wired (' + signerHooks.source + ')');
    }
    await hub.oraclePublisher.start();
}

class Oracle {

    async startOracle(){
        if(!this.peerManager) return;
        const modules = this.constructor.modules;
        const { OracleRound, OracleConsensus, RewardTracker, SlashDetector } = modules;

        this.oracle = new OracleRound(this);

        this.oracleConsensus = new OracleConsensus(this, this.oracle);
        let validators = await this.loadValidatorSet();
        this.oracleConsensus.setValidatorSet(validators);

        this.oracle.setConsensus(this.oracleConsensus);

        this.rewardTracker = new RewardTracker(this);
        this.slashDetector = new SlashDetector(this);

        this.oracleConsensus.on('round:finalized', async (event) => {
            // db.doQuery throws on query errors, and a rejection out of an EventEmitter
            // listener is an unhandled rejection, which exits the process.
            try {
                // event.participants are SIGNING KEYS (OracleConsensus tallies votes
                // by proven key), so they need no registry translation. That is the
                // point: the old addr->pubkey lookup silently paid nobody for a
                // validator the chain attributes but the local registry has no row
                // for, so a community validator could vote and never be rewarded.
                let participantPubkeys = (event.participants || [])
                    .filter(pk => pk)
                    .map(pk => String(pk).toLowerCase());

                await this.rewardTracker.distributeRewards(event.round, participantPubkeys, event.btcBlockHeight);

                // Re-loaded per round: the set captured at startOracle() goes stale, so
                // rotated-in validators escaped slashing and removed ones kept accruing misses.
                // On a transient load failure fall back to the last-known-good set rather than
                // skipping the participation check for the round.
                let currentValidators = await this.loadValidatorSet();
                if(currentValidators.length > 0){
                    validators = currentValidators;
                }

                await this.slashDetector.checkRound(
                    event.round, event.submissions, event.prices,
                    participantPubkeys, validators
                );
            } catch (e){
                logger.error(nodeUtil.format('round:finalized reward/slash handling failed for round %s:', (event && event.round), e && e.message ? e.message : e));
            }
        });

        await this.oracleConsensus.start();
        await this.oracle.start();

        await startOraclePublishing(this, modules);
    }
}

module.exports = Oracle;
