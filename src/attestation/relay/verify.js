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
 * XChain Hub - Attestation cross-chain relay: follower verification
 *
 * What a peer re-derives from its OWN indexers before co-signing a leader's proposed
 * leg, plus the cross_chain capability set the round is judged against and the
 * snapshot mirror write. Installed on AttestationRelay.prototype by
 * src/attestation/relay.js.
 *
 ********************************************************************/

'use strict';

const swq         = require('../../stake_weighted_quorum.js');
const attestRelay = require('../../attest_relay_activation.js');
const { allCanonicalInts } = require('../../lib/canonical_int.js');
const { RELAY_CANONICAL_INT_FIELDS, HOME_CHAIN, ORIGIN_CHAINS, SNAPSHOT_DRIFT_BLOCKS } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // ----- follower verification -----

    // What a peer checks before co-signing a leader's proposed row. The federation
    // must never vouch for a leg it cannot independently reconstruct from its OWN
    // indexers, which is the same fail-closed stance the XCALL relay takes. Anything
    // unrecognised is refused rather than falling through to a permissive default.
    async validateProposedMatch(row){
        if(!row) return false;
        // Canonical integer spellings. These fields are signed verbatim into
        // _relayRequestCanonical / _relayResponseCanonical and ride the v3/v4 wire, but
        // the indexer re-parses them with parseInt() before rebuilding the canonical it
        // verifies against. A leader-supplied '041' therefore passes the Number()-based
        // field checks below, collects an honest quorum, and lands an action the origin
        // chain stores as invalid ('cross_chain quorum') with no path to re-relay: the
        // request sits until its deadline expires. Fail closed before either leg runs.
        if(!RELAY_CANONICAL_INT_FIELDS[row.phase]) return false;
        if(!allCanonicalInts(row, RELAY_CANONICAL_INT_FIELDS[row.phase])) return false;
        if(row.phase === 'request')  return await this.validateRequestRow(row);
        if(row.phase === 'response') return await this.validateResponseRow(row);
        return false;
    },

    // Checks common to both legs: the row identifies itself consistently, its round
    // id binds the leg it claims to be, and the leader's snapshot choice is close
    // enough to our own tip view. An ancient snapshot_block would let a Byzantine
    // leader select a stale cross_chain validator set for the indexer's check.
    async validateRowEnvelope(row, phase, rid){
        if(!/^[0-9a-f]{64}$/.test(rid)) return false;
        if(ORIGIN_CHAINS.indexOf(String(row.origin_chain)) === -1) return false;
        if(String(row.network || '') !== String(this.network || '')) return false;
        if(String(row.round_id).toLowerCase() !== this._roundId(phase, rid)) return false;
        if(!attestRelay.isAttestRelayActive(row.snapshot_block, this.network)) return false;
        let myBlock = await this.resolveSnapshotBlock();
        if(myBlock != null && Math.abs(Number(row.snapshot_block) - Number(myBlock)) > SNAPSHOT_DRIFT_BLOCKS) return false;
        return true;
    },

    async validateRequestRow(row){
        let rid = String(row.request_id || '').toLowerCase();
        if(!await this.validateRowEnvelope(row, 'request', rid)) return false;

        // A request already on the home chain must not be materialized twice; the
        // indexer would reject the duplicate, so co-signing it only wastes a fee.
        if(this.homeHasRequest(rid)) return false;

        let coin = String(row.origin_chain);
        let res  = await this.fetchAllPages(coin, 'getpendingattestation_requests', 'requests');
        if(!res.ok) return false;

        let mine = res.rows.find(r => String(r.request_id || '').toLowerCase() === rid);
        if(!mine) return false;
        if(String(mine.origin_chain || '') !== coin) return false;

        // The request leg needs no deadline field on the row: this node is looking at
        // the origin row itself, which carries the absolute deadline. Index it here so a
        // node that only ever CO-SIGNS (and therefore never runs maybeMaterialize for
        // this request) can still evict the record its own broadcast may create.
        this.noteDeadline(coin, rid, mine.deadline_block);
        if(Number.isFinite(Number(res.latest))) this._originLatest[coin] = Number(res.latest);
        if(this.pastEvictionHorizon(coin, mine.deadline_block)) return false;

        let depth = Number(res.latest) - Number(mine.block_index) + 1;
        if(!Number.isFinite(depth) || depth < this.confirmations[coin]) return false;

        let fields = this.relayFieldsFromOrigin(coin, mine);
        if(!fields) return false;

        return fields.originActionIndex === Number(row.origin_action_index) &&
               fields.providerId        === String(row.provider_id) &&
               fields.redundancy        === Number(row.redundancy) &&
               fields.deadlineBlocks    === Number(row.deadline_blocks) &&
               this._sha256(fields.requestPayload) === this._sha256(String(row.request_payload == null ? '' : row.request_payload));
    },

    // The response leg's re-verification, which is what replaces the old blanket
    // refusal of phase != 'request'. It has to confirm BOTH ends independently,
    // because the v4 is the only leg that irreversibly SETTLES anything: it closes
    // the origin request, releases its escrow and fires the contract's callback.
    //
    //   home side   the terminal response really exists on OUR BTC indexer, at the
    //               action_index the row names, for a request BTC holds as a foreign-
    //               origin relay leg, and deep enough that a BTC reorg cannot take it
    //               back after the origin has already settled against it;
    //   origin side the request is one OUR origin indexer still has PENDING and still
    //               marks relay-eligible, so a v4 the origin will reject (or one that
    //               would close a request the federation was never asked to service)
    //               is never signed;
    //   the body    re-derived here rather than trusted, so the payload, hash, status
    //               and meta a follower signs are its own reading of BTC and not the
    //               leader's claim about it.
    async validateResponseRow(row){
        let rid = String(row.request_id || '').toLowerCase();
        if(!await this.validateRowEnvelope(row, 'response', rid)) return false;

        let coin = String(row.origin_chain);

        let origin = await this.fetchAllPages(coin, 'getpendingattestation_requests', 'requests');
        if(!origin.ok) return false;
        let originReq = origin.rows.find(r => String(r.request_id || '').toLowerCase() === rid);
        if(!originReq) return false;
        if(String(originReq.origin_chain || '') !== coin) return false;
        // The origin indexer builds its canonical from ITS OWN request row's
        // provider_id, so a row naming a different one signs bytes the origin will
        // never reproduce, and the v4 would be dropped as unquorate.
        if(String(originReq.provider_id || '') !== String(row.provider_id)) return false;

        // Re-derive the threaded deadline rather than trusting it. A leader that
        // named a deadline this node's own origin indexer does not hold is refused, so the
        // eviction clock can never be moved forward by a peer. An ABSENT field is tolerated
        // (a leader running code that predates this field): the value is bookkeeping,
        // and refusing over it would wedge a mixed-version fleet on the leg that settles.
        if(!this.checkOriginDeadline(row, originReq)) return false;
        if(Number.isFinite(Number(origin.latest))) this._originLatest[coin] = Number(origin.latest);
        // The leg the leader proposed is past recall on this node's own view of the
        // origin: co-signing it would fund a v4 the origin rejects as expired.
        if(this.pastEvictionHorizon(coin, originReq.deadline_block)) return false;

        let res;
        try { res = await this._indexerCall(HOME_CHAIN, 'getrelayedattestation_requests', { request_id: rid, limit: 1 }); }
        catch(e){ return false; }
        if(!res || !Array.isArray(res.requests)) return false;

        let home = res.requests.find(r => String(r.request_id || '').toLowerCase() === rid);
        if(!home) return false;
        if(String(home.origin_chain || '') !== coin) return false;
        if(home.response_action_index == null) return false;
        if(Number(home.response_action_index) !== Number(row.home_response_action_index)) return false;

        let depth = Number(res.latest_block_index) - Number(home.response_block_index) + 1;
        if(!Number.isFinite(depth) || depth < this.confirmations[HOME_CHAIN]) return false;

        let fields = this.responseFieldsFromHome(home);
        if(!fields) return false;

        return fields.providerId   === String(row.provider_id) &&
               fields.responseHash === String(row.response_hash || '').toLowerCase() &&
               fields.payloadB64   === String(row.response_payload_b64 == null ? '' : row.response_payload_b64) &&
               fields.status       === String(row.status) &&
               fields.meta         === String(row.meta == null ? '' : row.meta);
    },

    // Source-keyed at/above STAKE_WEIGHTED_QUORUM, legacy count set below it. Mirrors
    // CrossChainCallEngine so the relay resolves the identical cross_chain set the
    // XCALL rail does at the same block.
    async resolveCapabilityValidators(capability, block, network){
        let validators = [];
        let weighted = swq.isStakeWeightedQuorumActive(block, network);
        if(this.capSnapshot){
            if(weighted){
                let snap = await this.capSnapshot.getWeightSnapshot(capability, block);
                if(snap && Array.isArray(snap.validators)){
                    validators = snap.validators.map(v => ({
                        pubkey: v.pubkey, source: String(v.source != null ? v.source : ''),
                        weight: String(v.weight != null ? v.weight : '0'),
                        amount: String(v.weight != null ? v.weight : '0')
                    }));
                    // Carry truncation through so the consensus fails closed on an
                    // over-cap weighted snapshot (SWQ-TRUNC parity).
                    if(snap.truncated === true) validators.truncated = true;
                }
            } else {
                let snap = await this.capSnapshot.getSnapshot(capability, block);
                if(snap && Array.isArray(snap.validators)){
                    validators = snap.validators.map(v => ({
                        pubkey: v.pubkey, source: '',
                        weight: String(v.amount != null ? v.amount : '0'),
                        amount: String(v.amount != null ? v.amount : '0')
                    }));
                    // getSnapshot marks an over-cap COUNT set truncated too, and the persist
                    // guard reads the marker off this array, so carry it in both modes or the
                    // mirror takes a partial set below the stake-weighted flag day.
                    if(snap.truncated === true) validators.truncated = true;
                }
            }
        }
        return validators;
    }

};
