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
 * XChain Hub - Bridge Policy Snapshot Round
 *
 * The policy half of the engine: which (origin chain, tick) pairs this hub holds a policy
 * for, the confirmed origin height it reads them at, the membership hash it signs, and the
 * propagation window a snapshot carries to every chain that holds a copy.
 *
 ********************************************************************/

const crypto = require('crypto');
const { relayMarginFloorS } = require('../../lib/relay_margin.js');
const { XPOLICY_MAX_MEMBERS } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {
    // ---------------------------------------------------------------------------
    // Policy snapshots (policy spec section 3 step 2)
    // ---------------------------------------------------------------------------

    // Every (origin_chain, tick) pair this hub should hold a current policy for: the pairs
    // its own finalized transfers name, plus any tick seen with a pending leg this cycle,
    // so a token's FIRST snapshot is signed in the same cycle its first lock is seen.
    async policyPairs(network){
        let pairs = new Map();
        let add = (origin, tick, copyChain) => {
            if(!origin || !tick) return;
            let key = origin + '|' + tick;
            let e = pairs.get(key) || { origin_chain: origin, tick: tick, copies: new Set() };
            if(copyChain && copyChain !== origin) e.copies.add(copyChain);
            pairs.set(key, e);
        };
        let rows = [];
        try { rows = await this.db.getBridgeTransferChainPairs(network); }
        catch(e){ rows = []; }
        for(let r of (rows || [])){
            let tick   = String(r.tick);
            let origin = this._tickOrigin.get(network + '|' + tick);
            // Without a learned origin the direction of the pair is unknowable from the row
            // alone (direction is derived, never stored, D19), so the pair waits for the poll
            // that carries its transfer_kind rather than guessing a side and signing a
            // snapshot read off the wrong chain.
            if(!origin) continue;
            let other = (String(r.src_chain) === origin) ? String(r.dest_chain) : String(r.src_chain);
            add(origin, tick, other);
        }
        for(let [key, amounts] of this._pendingInFlight){
            if(!amounts || !amounts.length) continue;
            let sep  = key.lastIndexOf('|');
            let tick = key.slice(0, sep);
            let dest = key.slice(sep + 1);
            let origin = this._tickOrigin.get(network + '|' + tick);
            if(!origin) continue;
            add(origin, tick, dest);
        }
        return [...pairs.values()];
    },

    async pollPolicySnapshots(snapshotBlock){
        let network = this.network;
        for(let pair of await this.policyPairs(network)){
            try { await this.maybeSnapshotPolicy(pair, network, snapshotBlock); }
            catch(e){ logger.warn('CrossChainBridge: policy round failed for ' + pair.origin_chain + ':' +
                                   pair.tick + ': ' + (e && e.message)); }
        }
    },

    // The confirmed origin height every follower can re-read identically: the origin tip
    // minus that chain's platform confirmation depth. Returns null when the tip is
    // unreadable, which ABSTAINS this cycle rather than reading at an unconfirmed height.
    async policyOriginBlock(originChain){
        let res;
        try { res = await this._indexerCall(originChain, 'getlatestblock', {}); }
        catch(e){ return null; }
        let latest = Number(res && (res.block_index != null ? res.block_index : res.latest_block_index));
        if(!Number.isFinite(latest)) return null;
        let at = latest - Number(this.confirmations[originChain] || 1);
        return at > 0 ? at : null;
    },

    async maybeSnapshotPolicy(pair, network, snapshotBlock){
        let originChain = pair.origin_chain;
        let signable = await this.readSignablePolicy(pair, originChain);
        if(!signable) return;
        let { originBlock, shaped, hash } = signable;

        let lastSeq = await this.db.getLatestPolicySeq(network, originChain, pair.tick);
        if(lastSeq > 0){
            let held = await this.db.getPolicySnapshotAtSeq(network, originChain, pair.tick, lastSeq);
            // Unchanged policy: nothing to sign. This is the common case every cycle.
            if(held && String(held.policy_hash).toLowerCase() === hash) return;
        }
        let policySeq = lastSeq + 1;
        let snapshotId = this._deriveSnapshotId(network, originChain, pair.tick, policySeq, snapshotBlock);
        if(this._inflight.has(snapshotId)) return;

        let row = {
            snapshot_id:     snapshotId,
            snapshot_block:  Number(snapshotBlock),
            origin_chain:    originChain,
            tick:            pair.tick,
            policy_seq:      policySeq,
            origin_block:    Number(originBlock),
            policy_hash:     hash,
            allow_list:      shaped.allow === null ? null : JSON.stringify(shaped.allow),
            block_list:      shaped.block === null ? null : JSON.stringify(shaped.block),
            sleeping:        shaped.sleeping ? 1 : 0,
            // Sized to the SLOWEST chain that holds a copy per this hub's own transfer rows,
            // never over the issuer's BRIDGE_CHAINS (which an issuer can empty while copies
            // are still outstanding). NOT monotonic across policy_seq, which is why apply
            // order is by seq and never by time.
            effective_time:  this._nowSeconds() + this.policyMarginS(pair.copies, originChain),
            network:         network,
            push_generation: 0
        };

        // The SHARP case: a policy snapshot's consuming select carries no chain clause, so
        // its map must cover every chain the federation serves, NOT the pair's own copies.
        if(!await this.stampAdmission('policy_snapshots', row, 'policy snapshot ' + snapshotId)) return;

        let validators = await this.resolveCapabilityValidators('cross_chain', Number(snapshotBlock), network);
        this._inflight.add(snapshotId);
        try {
            await this.policyConsensus.propose(snapshotId, {
                row: row, snapshot: { validators: validators, count: validators.length }
            });
        } catch(e){
            this._inflight.delete(snapshotId);
            throw e;
        }
    },

    // The origin's policy for `pair` at its confirmed height, shaped and checked against its
    // own hash, or undefined when this cycle signs nothing for the pair.
    async readSignablePolicy(pair, originChain){
        if(!this.indexers[originChain] || !this.indexers[originChain].url) return;
        let originBlock = await this.policyOriginBlock(originChain);
        if(originBlock == null) return;

        let policy;
        try { policy = await this._indexerCall(originChain, 'gettokenpolicy', { tick: pair.tick, origin_block: originBlock }); }
        catch(e){ return; }                       // read failure abstains; never refuses (D16)
        if(!policy || policy.error) return;       // the tick has no native row here

        let shaped = this.shapePolicy(policy);
        if(!shaped) return;
        // The membership ceiling (R2). Declining is the whole action: the previous snapshot
        // stays in force and the watch raises WARN, so an oversized list can never be
        // materialized onto a copy but also never wedges the tick's existing policy.
        if(shaped.oversized){
            logger.warn('CrossChainBridge: declining to sign a policy snapshot for ' + originChain + ':' +
                         pair.tick + ' (a list exceeds XPOLICY_MAX_MEMBERS=' + XPOLICY_MAX_MEMBERS +
                         '); the previous snapshot stays in force');
            return;
        }
        // Membership arrays are TRANSPORT and are verified against the hash on apply, so a
        // snapshot whose own indexer answer does not hash to its own policy_hash would be
        // refused by every destination. Recompute rather than trust the read.
        let hash = this._policyHash(shaped.allow, shaped.block, shaped.sleeping);
        if(String(policy.policy_hash || '').toLowerCase() !== hash){
            logger.warn('CrossChainBridge: gettokenpolicy for ' + originChain + ':' + pair.tick +
                         ' returned a policy_hash that does not match its own membership; not signing');
            return;
        }
        return { originBlock, shaped, hash };
    },

    // The propagation window an effective_time carries: `max(relayMarginFloorS(c))` over
    // every chain c that holds a COPY of this tick (policy spec section 5, and the
    // effective_time column comment in src/sql/policy_snapshots.sql). The copies are the
    // only indexers that ever APPLY the snapshot, so they are the only ones the deadline
    // has to reach; a BTC copy pins it at 2400 s, copies {DOGE} at 240 s, {DOGE,LTC} at the
    // larger of those two. Seeding the maximum with BTC's floor unconditionally would stamp
    // 2400 s on a snapshot whose copies are all fast chains, which is not what the spec
    // says and which delays every policy change on a DOGE-only token by forty minutes.
    //
    // With NO copies (a burn back to the origin is the only leg this hub has seen) there is
    // no destination to reach, but the row still needs a window in the future to be
    // co-signed at all, so it falls back to the origin chain's own floor: the origin
    // indexer is the only one that holds the tick.
    policyMarginS(copies, originChain){
        let list = [...(copies || [])];
        if(!list.length) return relayMarginFloorS(originChain);
        let margin = 0;
        for(let c of list) margin = Math.max(margin, relayMarginFloorS(c));
        return margin;
    },

    // Normalize a gettokenpolicy answer into the three signed inputs, or null when the
    // answer is not usable. A list is either null (the origin row has no such list) or an
    // array of members; the arrays must already be in canonical order, which the apply side
    // also verifies and never re-sorts (D13), so an out-of-order answer is refused here too
    // rather than silently re-sorted into a hash the origin never held.
    shapePolicy(policy){
        let one = (v) => {
            if(v === null || v === undefined) return null;
            if(!Array.isArray(v)) return undefined;
            return v.map(x => String(x));
        };
        let allow = one(policy.allow_list);
        let block = one(policy.block_list);
        if(allow === undefined || block === undefined) return null;
        if(!this.isCanonicalOrder(allow) || !this.isCanonicalOrder(block)) return null;
        let oversized = (allow && allow.length > XPOLICY_MAX_MEMBERS) ||
                        (block && block.length > XPOLICY_MAX_MEMBERS);
        return { allow: allow, block: block, sleeping: !!policy.sleeping, oversized: !!oversized };
    },

    // Byte order (utf8_bin), strictly ascending: the order getList returns for a type-2
    // list. Buffer.compare is the byte comparison; String < would use UTF-16 code units,
    // which differ from byte order above the BMP.
    isCanonicalOrder(list){
        if(list === null) return true;
        for(let i = 1; i < list.length; i++){
            if(Buffer.compare(Buffer.from(list[i - 1], 'utf8'), Buffer.from(list[i], 'utf8')) >= 0) return false;
        }
        return true;
    },

    // sha256 over the canonical membership text (policy spec section 5):
    //   ALLOW|<n or ->|<addr>|... |BLOCK|<m or ->|<addr>|... |SLEEP|<0 or 1>
    // `-` means the origin row has no such list, `0` means it has an EMPTY one. The two are
    // not the same thing: isActionAllowed denies everyone on an empty allow list, so a copy
    // must be able to tell "no policy" from "allow nobody".
    _policyHash(allow, block, sleeping){
        let part = (label, list) => {
            if(list === null) return [label, '-'];
            return [label, String(list.length)].concat(list.map(a => String(a)));
        };
        let text = part('ALLOW', allow)
            .concat(part('BLOCK', block))
            .concat(['SLEEP', sleeping ? '1' : '0'])
            .join('|');
        return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    },
};
