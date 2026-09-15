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
 * XChain Hub - Price Aggregator: derived capability resolve and persist
 *
 * Reads the qualifying validator set for one capability at one BTC height from
 * the same Bitcoin view the consensus path uses, and writes it through the same
 * shared writer, so a chain-only hub's rows are byte-identical to a validator's.
 *
 ********************************************************************/

const swq               = require('../../stake_weighted_quorum.js');
const snapWrite         = require('../../lib/capability_snapshot_write.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Broadcast the committed rows, keyed on the full widened uq_cap_snap (block,
// capability, pubkey, SOURCE) exactly as the consensus path re-reads them: a
// pubkey delegated by two sources has two rows, and a pubkey-only LIMIT 1 re-read
// would stream only one. Without this the indexer never receives them live.
// Delivery is not allowed to un-commit the write, so a broadcast failure is
// reported and the block still counts as covered.
async function mirrorSnapshotRows(capability, block, rows) {
    try {
        if (this.hub && this.hub.hubDbBroadcaster) {
            for (let row of rows) {
                let r = await this.db.getCapabilitySnapshot(block, capability, row.signing_pubkey, row.source);
                if (r.length) this.hub.hubDbBroadcaster.broadcastRow({ table: 'capability_snapshots', row: r[0] });
            }
        }
    } catch (e) {
        logger.error('PriceAggregator: mirroring the derived ' + capability + ' capability snapshot at '
            + 'block ' + block + ' to subscribers failed: ' + (e && e.message));
    }
}

module.exports = {

    // Resolve the qualifying validator set for `capability` at a BTC block, normalized to
    // { pubkey, source, weight, amount }.
    //
    // The resolution is OracleConsensus.resolveCapabilityValidators verbatim (same
    // activation key, same two RPCs, same normalization, same truncation marker), with
    // ONE deliberate difference: a degraded read returns null here instead of collapsing
    // to []. Both refuse to write, but only the null tells the caller the Bitcoin view
    // failed, which is the difference between "retry and say so" and "this height really
    // has no qualified validators".
    //
    // The capability is a pass-through to the BTC indexer RPC, exactly as it is in the
    // six consensus writers: `getcapabilityvalidators` / `getstakeweightsbycapability`
    // take it as a parameter, and CapabilitySnapshot keys its cache and its min_stake
    // lookup on it. Nothing else about the resolution differs per capability, which is
    // why one resolver serves all four.
    async resolveDerivedCapabilityValidators(capability, block) {
        let capSnapshot = this.hub ? this.hub.capabilitySnapshot : null;
        if (!capSnapshot) return null;
        // The hub's OWN deployment network is the activation key for every capability,
        // `cross_chain` included: STAKE_WEIGHTED_QUORUM_ACTIVATION is keyed
        // mainnet/testnet/regtest, and the engines' third `network` argument carries the
        // same value read off the match row. See DERIVED_CAPABILITIES.
        let weighted = swq.isStakeWeightedQuorumActive(block, this.hub.network);
        if (weighted) {
            if (typeof capSnapshot.getWeightSnapshot !== 'function') return null;
            let snap = await capSnapshot.getWeightSnapshot(capability, block);
            if (!snap || !Array.isArray(snap.validators)) return null;
            let validators = snap.validators.map(v => ({
                pubkey: v.pubkey,
                source: String(v.source != null ? v.source : ''),
                weight: String(v.weight != null ? v.weight : '0'),
                amount: String(v.weight != null ? v.weight : '0')
            }));
            // Carry the truncation marker through the .map so the persist can refuse an
            // over-cap set (SWQ-TRUNC parity with the other writers).
            if (snap.truncated === true) validators.truncated = true;
            return validators;
        }
        let snap = await capSnapshot.getSnapshot(capability, block);
        if (!snap || !Array.isArray(snap.validators)) return null;
        let counted = snap.validators.map(v => ({
            pubkey: v.pubkey,
            source: '',
            weight: String(v.amount != null ? v.amount : '0'),
            amount: String(v.amount != null ? v.amount : '0')
        }));
        // getSnapshot marks an over-cap COUNT set truncated as well, and the persist guard
        // reads the marker off this array, so carry it in both modes.
        if (snap.truncated === true) counted.truncated = true;
        return counted;
    },

    // The `price` resolver under its original name. CapabilitySnapshotTruncationParity
    // drives this exact signature to prove the COUNT-mode truncation marker survives the
    // .map, and that guard is about the resolver's shape, not about which capability it
    // was asked for, so the name stays and the widened resolver does the work.
    async resolvePriceCapabilityValidators(block) {
        return this.resolveDerivedCapabilityValidators('price', block);
    },

    // Persist the `capability` set at `block` and mirror it to hub-DB subscribers. The
    // write and the select-back are OracleConsensus.persistCapabilitySnapshot's, through
    // the same shared writer, so the rows a chain-only hub produces are byte-identical to
    // a validator hub's for the same block and INSERT IGNORE makes either order a no-op
    // for the other.
    //
    // Returns { status, rows }: 'written', 'empty' (read fine, nobody qualified),
    // 'unresolved' (the Bitcoin view failed), 'truncated' or 'error'.
    async persistDerivedCapabilitySnapshot(capability, block) {
        let validators = await this.resolveDerivedCapabilityValidators(capability, block);
        if (validators === null) return { status: 'unresolved', rows: 0, detail: 'Bitcoin view unreachable or degraded' };
        // SWQ-TRUNC-MIRROR, held exactly as OracleConsensus states it: never mirror a
        // TRUNCATED set. The marker is a JS array property with no capability_snapshots
        // column behind it, so persisting the capped rows would hand an off-BTC verifier
        // a partial set it reads back as COMPLETE and let it clear a 2/3 bar over an
        // under-counted stake denominator this hub itself rejects. Writing nothing leaves
        // the mirror empty, so that read yields S=0 and fails closed through the same
        // predicate as everything else.
        if (validators.truncated === true) {
            logger.warn('PriceAggregator: refusing to persist a TRUNCATED ' + capability + ' capability '
                + 'snapshot at block ' + block + ' (over the source cap; raise VALIDATOR_QUERY_LIMIT '
                + 'fleet-wide). No rows mirrored.');
            return { status: 'truncated', rows: 0 };
        }
        if (validators.length === 0) return { status: 'empty', rows: 0 };

        let rows;
        try {
            rows = await snapWrite.writeCapabilitySnapshotRows(this.db, capability, block, validators);
        } catch (e) {
            return { status: 'error', rows: 0, detail: e && e.message ? e.message : String(e) };
        }
        await mirrorSnapshotRows.call(this, capability, block, rows);
        return { status: 'written', rows: rows.length };
    },

    // The `price` persist under its original name, kept for callers and tests that
    // predate the widening (row 45's shape). Same write, same guard, same rows.
    async persistPriceCapabilitySnapshot(block) {
        return this.persistDerivedCapabilitySnapshot('price', block);
    }

};
