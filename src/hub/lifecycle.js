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
 * XChain Hub - Boot and Shutdown
 *
 * The boot ladder a hub climbs and the order it comes back down in: the
 * database and the row mirror, the P2P transport and its chain-effective
 * signer set, config consensus, and the shutdown that disarms each engine.
 *
 ********************************************************************/

const coins = require('../coins');
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();

class Lifecycle {

    async start(){
        const { Database, PriceAggregator, HubDbBroadcaster } = this.constructor.modules;
        // Verify the bundled canonical coin files against CONSENSUS_CONFIG_PIN before any DB
        // or serving work, mirroring the indexer's boot check. The hub is the platform's
        // config oracle: it acts on this config for PBFT, oracle and attestation AND serves
        // consensusHashes to every consumer, so a drifted bundle must halt boot rather than
        // propagate federation-wide. A null pin skips; a mismatch on an armed network throws,
        // which is fail-closed.
        for(const net of coins.NETWORKS) coins.verifyConsensusPin(net);

        this.db = new Database(this.dbHost, this.dbPort, this.dbName, this.dbUser, this.dbPass);
        await this.db.createDatabase();
        await this.db.verifyTables();
        await this.db.runMigrations();

        // Started here, not in startP2P: receiving on-chain PRICE actions needs no
        // consensus, so a standalone hub still aggregates.
        this.priceAggregator = new PriceAggregator(this);
        // Mirrors aggregator row writes onto the hub-DB sync channel over WebSocket, which
        // indexers running in distributed mode subscribe to.
        this.hubDbBroadcaster = new HubDbBroadcaster(this.p2pConfig || {}, this.db);
        this.priceAggregator.on('row:inserted', (event) => {
            this.hubDbBroadcaster.broadcastRow(event);
            this.noteAggregatorRow(event);
        });
        this.priceAggregator.on('row:deleted', (event) => {
            this.hubDbBroadcaster.broadcastDeletion(event);
        });
        // Arm the derived `price` capability snapshot pass. Armed here, beside the
        // aggregator and BEFORE startP2P/startOracle, because it must run on a hub that
        // never reaches either: without it nothing writes a `price` capability snapshot
        // on a non-consensus hub, its mirror stays empty, and its indexer records every
        // on-chain PRICE batch `invalid: insufficient signer stake`. The pass itself
        // disarms on a hub that DOES run oracle consensus, whose round-finalization
        // writer already owns those rows; see PriceAggregator.runsOracleConsensus for
        // why that decision is deferred to the first pass rather than taken here.
        this.priceAggregator.startPriceCapabilityDerivation();
        logger.info('XChain Hub started (MariaDB: ' + this.dbName + ')');
    }

    // Advance the oracle clamp reference on finalized rounds that arrive by PUSH.
    // PriceAggregator.receiveValidatedRound writes 'finalized' price_snapshots rows for
    // rounds pushed from a source chain and touches no consensus state, so a hub that
    // INGESTED round N went on clamping against N-1 for the process lifetime (item
    // 5834). Guarded and never fatal: this feeds a local accept-gate input, and a throw
    // must not escape into the mirror broadcast that shares the listener.
    noteAggregatorRow(event){
        try {
            if(event && event.table === 'price_snapshots' && this.oracleConsensus){
                this.oracleConsensus.noteIngestedPriceRow(event.row);
            }
        } catch (e){
            logger.warn(nodeUtil.format('Oracle: could not fold an ingested price row into the clamp reference:',
                e && e.message ? e.message : e));
        }
    }

    async startP2P(){
        if(!this.p2pConfig) return;
        const { ValidatorIdentity, PeerManager } = this.constructor.modules;

        if(this.p2pConfig.SIGNING_PRIVKEY_HEX){
            this.identity = new ValidatorIdentity(this.p2pConfig.SIGNING_PRIVKEY_HEX);
            logger.info('Validator identity loaded (pubkey: ' + this.identity.getPubkeyHex().substring(0, 16) + '...)');
        }

        this.peerManager = new PeerManager(this.p2pConfig, this.db);

        if(this.identity){
            this.peerManager.setIdentity(this.identity);
        }

        // MUST succeed before the P2P listener opens: a null registry makes
        // verifySignature accept any signed envelope from any sender. On a DB failure this
        // throws, so start() below is never reached.
        await this.loadValidatorPubkeys();

        // Fail closed: refuse to open the P2P listener with a null registry. An empty
        // (non-null) registry is fine: it rejects every unknown sender, the correct
        // pre-bootstrap state while validators are still registering.
        if(!this.peerManager.validatorPubkeys){
            throw new Error('Validator registry not loaded; refusing to start the P2P listener (database unavailable?)');
        }

        await this.peerManager.start();

        // Option A transport auth: follow the on-chain effective signer set so transport
        // auth tracks validator key rotation without manual registry edits. Best-effort
        // immediate refresh plus a periodic poll, and inert where there is no chain
        // validator set, an empty snapshot leaving the registry as the auth floor.
        // Rationale at refreshTransportSignerSet.
        let refreshMs = (this.p2pConfig && this.p2pConfig.P2P_SIGNER_SET_REFRESH_MS) || 30000;
        this.refreshTransportSignerSet().catch(e => logger.error(nodeUtil.format('Initial transport signer-set refresh failed:', e)));
        this._transportSetTimer = setInterval(() => {
            this.refreshTransportSignerSet().catch(e => logger.error(nodeUtil.format('Transport signer-set refresh failed:', e)));
        }, refreshMs);
    }

    // Refresh the chain-effective signer set from the on-chain validator snapshot. The
    // set is ADDITIVE to the registry, so transport auth follows key rotation; it is
    // NEVER cleared on an upstream failure, since the registry stays the auth floor.
    // In-flight guard, the same one pollOwnStake and runOwnCapabilityCheck carry: the
    // two awaits below are unbounded round trips, so a slow indexer lets the bare
    // setInterval stack passes. Each pass resolves the BTC tip at its own START, so an
    // older slow pass finishing last would write the OLDER block's validator snapshot
    // over a newer one and drop a just-rotated key from transport auth. Serializing the
    // passes orders the writes; a skipped tick costs at most one refresh interval of
    // staleness, which the registry auth floor already covers.
    async refreshTransportSignerSet(){
        if(!this.peerManager) return;
        if(this._transportSetRefreshRunning) return;
        this._transportSetRefreshRunning = true;
        try {
            let block = await this._resolveBtcLatestBlock();
            if(block == null){ this.warnTransportStale('BTC tip unresolved'); return; }
            let snap = await this.capabilitySnapshot.getActiveValidatorSnapshot(block);
            if(!snap || !Array.isArray(snap.validators)){ this.warnTransportStale('validator snapshot unavailable'); return; }
            let set = new Set(snap.validators.map(v => String(v.pubkey).toLowerCase()));
            this._transportSignerSet   = set;
            this._transportSignerSetAt = Date.now();
            this.peerManager.setEffectiveSignerSet(set);
            this.reportOwnSignerSetMembership(set);
        } finally {
            this._transportSetRefreshRunning = false;
        }
    }

    // Say on THIS hub whether its own signing key is in the set every peer authenticates
    // against. An unstaked or not-yet-activated validator is otherwise silent locally:
    // the only evidence is a reject line in the logs of the peers dropping it, which its
    // operator cannot read. Logged on transition only (the first resolved set counts as a
    // transition), so a hub waiting out stake activation prints one line, not one per
    // refresh, and prints one more when it is admitted.
    reportOwnSignerSetMembership(set){
        const { PeerManager } = this.constructor.modules;
        if(!this.identity || !set) return;
        let pubkey;
        try { pubkey = String(this.identity.getPubkeyHex()).toLowerCase(); }
        catch(e){ return; }
        let inSet = set.has(pubkey);
        if(inSet === this._ownPubkeyInSignerSet) return;
        this._ownPubkeyInSignerSet = inSet;
        if(inSet){
            logger.info('XChainHub: this hub\'s signing pubkey is now in the chain-effective signer ' +
                'set; peers will accept its messages (pubkey ' + pubkey + ')');
            return;
        }
        let blocks = PeerManager.stakeActivationBlocks(this.network);
        logger.warn('XChainHub: this hub\'s signing pubkey is NOT in the chain-effective signer set, ' +
            'so it runs as an observer (mirroring and serving, authoring nothing) until a STAKE ' +
            'for it confirms and activates' +
            (blocks === null ? '' : ' (' + blocks + ' blocks after the transaction confirms)') +
            ' (pubkey ' + pubkey + ')');
    }

    // Warn once the last good refresh ages past a threshold. Never clears the set (the
    // no-fail-open invariant above), and stays silent before the first refresh.
    warnTransportStale(why){
        let maxAgeMs = (this.p2pConfig && this.p2pConfig.P2P_SIGNER_SET_MAX_AGE_MS) || 600000;
        if(this._transportSignerSetAt && (Date.now() - this._transportSignerSetAt) > maxAgeMs){
            logger.warn('XChainHub: transport signer set STALE (' + why + '); retaining last-known-good set of ' +
                this._transportSignerSet.size + ' pubkey(s); registry remains the auth floor');
        }
    }

    async startConsensus(){
        if(!this.peerManager) return;
        const { Consensus } = this.constructor.modules;
        this.consensus = new Consensus(this);

        let validators = await this._loadValidatorSet();
        this.consensus.setValidatorSet(validators);

        await this.consensus.start();
    }

    getPeerManager(){
        return this.peerManager;
    }

    getConsensus(){
        return this.consensus;
    }

    getIdentity(){
        return this.identity;
    }

    getOracle(){
        return this.oracle;
    }

    async close(){
        if(this._capabilityRecheckTimer){ clearInterval(this._capabilityRecheckTimer); this._capabilityRecheckTimer = null; }
        if(this._stakePollTimer){ clearInterval(this._stakePollTimer); this._stakePollTimer = null; }
        if(this._transportSetTimer){ clearInterval(this._transportSetTimer); this._transportSetTimer = null; }
        if(this.stakeShareWatcher){ this.stakeShareWatcher.stop(); }
        // Disarmed with the other timers, and for the same reason the attestation batch
        // publisher is: its pass ends in a DB write, so leaving it armed past db.close()
        // would run one against a dead pool.
        if(this.priceAggregator) this.priceAggregator.stopPriceCapabilityDerivation();
        if(this._capabilityConfigDebounce){ clearTimeout(this._capabilityConfigDebounce); this._capabilityConfigDebounce = null; }
        if(this._capabilityConfigWatcher){ try { this._capabilityConfigWatcher.close(); } catch(e){} this._capabilityConfigWatcher = null; }
        if(this.governance)       await this.governance.stop();
        if(this.reorgHandler)     await this.reorgHandler.stop();
        if(this.rollcallRound)    await this.rollcallRound.stop();
        // Detached BEFORE db.close() below: the listener's only side effect is a DB
        // write, so leaving it attached past the close turns a late-finalizing round
        // into an error on a dead pool instead of a no-op.
        if(this.attestationResponseMirror) await this.attestationResponseMirror.stop();
        // Stopped beside the mirror and for the same reason: its window timer's only
        // side effect is a DB read followed by a spend, so leaving it armed past the
        // close would run a publish pass against a dead pool.
        if(this.attestationBatchPublisher) this.attestationBatchPublisher.stop();
        // The rest of the attestation family started in startAttestation(): each of
        // these detaches its own request:finalized, peerManager or reorgHandler
        // listener, so skipping one leaves it firing into a hub the caller believes
        // is fully closed, and a same-process restart doubles that listener again.
        if(this.attestationPublisher)   await this.attestationPublisher.stop();
        if(this.attestationSpotChecker) await this.attestationSpotChecker.stop();
        if(this.attestationRound)       await this.attestationRound.stop();
        if(this.fullNodeChallenge)      await this.fullNodeChallenge.stop();
        if(this.attestationRelay)       await this.attestationRelay.stop();
        // Stopped LAST among the attestation family: attestationRound proposes INTO
        // consensus (consensus.propose()), so stopping consensus before round would
        // let a poll already in flight fire into a consensus whose state is cleared.
        if(this.attestationConsensus)   await this.attestationConsensus.stop();
        if(this.stateAnchorPublisher) await this.stateAnchorPublisher.stop();
        if(this.retractionConsensus) this.retractionConsensus.stop();
        if(this.stateCheckpoints) await this.stateCheckpoints.stop();
        if(this.crossChainBridge) await this.crossChainBridge.stop();
        if(this.crossChainCalls)  await this.crossChainCalls.stop();
        if(this.crossChainDex)    await this.crossChainDex.stop();
        if(this.crossChain)       await this.crossChain.stop();
        if(this.oracleBatchSigner) await this.oracleBatchSigner.stop();
        if(this.oracle)           await this.oracle.stop();
        if(this.oracleConsensus)  await this.oracleConsensus.stop();
        if(this.consensus)        await this.consensus.stop();
        if(this.peerManager)      await this.peerManager.stop();
        if(this.db)               await this.db.close();
    }
}

module.exports = Lifecycle;
