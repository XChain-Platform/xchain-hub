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
 * XChain Hub - DEX Reservation Ledger
 *
 * The committed-fill ledger that decides how much of an offer is still offerable: its
 * rebuild from finalized matches, the per-leg apply and reverse, and the remaining capacity
 * every match derivation is computed against.
 *
 ********************************************************************/

const bc = require('../../bcmath.js');
const coins = require('../../coins');
const hubConfig = require('../../config');
const { ALLOWED_CHAINS, DEFAULT_MIN_CONFIRMATIONS } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

// True only for the driver's "this table does not exist" condition, which is the ONE
// rebuild failure that genuinely means "no finalized matches yet" (a hub whose schema
// has not been created). db.doQuery rethrows the driver error verbatim, so the
// structured errno/code survive; message text is not matched, because it is localized
// and carries the table name.
function isMissingTableError(e){
    return !!e && (Number(e.errno) === 1146 || e.code === 'ER_NO_SUCH_TABLE');
}

module.exports = {
    // The matching state a new engine starts from: the committed-fill ledger and its
    // readiness flag, the in-flight round set, and the per-coin confirmation floors.
    initMatchState(cfg){
        // Per-offer committed-fill ledger, keyed `<chain>:<action_index>` →
        // { give, get } cumulative amounts already locked into finalized (non-retracted)
        // matches. The authoritative reservation source (Phase B): the hub derives an
        // offer's remaining capacity from this ledger, not from the indexer-reported
        // remaining, which lags until the indexer's settlement pass runs:
        //   effective_remaining(give) = full_give − committed.give
        // A SWAP commits its full amount in one fill (→ remaining 0, drops out, exactly
        // the Phase-A single-fill behavior); an ORDER accrues partial fills until full.
        // Rebuilt on startup from cross_chain_matches and kept in sync on finalize/retract.
        this.committed = new Map();

        // Is the ledger above trustworthy? Only a FAILED rebuild falsifies it: an engine
        // that has never rebuilt has no poll timer and no consensus subscription, so it
        // can neither propose nor co-sign, and starting out true keeps a construct-only
        // engine behaving exactly as before. While false, _discoverAndMatch proposes
        // nothing and validateProposedMatch refuses to sign, because effectiveRemaining
        // subtracts this ledger from the full offer amount and an under-counted ledger
        // re-offers escrow that finalized matches already reserved.
        this._committedReady = true;

        // match_ids currently in a PBFT round but not yet written, so a fast next poll
        // doesn't re-propose the same deterministic fill. Cleared on write/failure;
        // _insertMatchRow is INSERT IGNORE so a slipped duplicate is still harmless.
        this._inflight = new Set();

        // Per-coin confirmation-depth floor for a give-side escrow (XDEX-CONF-1).
        // A 1-conf escrow that reorgs after the counter-leg settled on the other chain is
        // a cross-chain value loss, worst on DOGE; the sibling CrossChainCallEngine already
        // uses the per-chain defaults (BTC 6 / LTC 12 / DOGE 60) for the identical concern.
        // Precedence per coin: XDEX_MIN_CONFIRMATIONS_<COIN> > flat XDEX_MIN_CONFIRMATIONS
        // (legacy knob, e.g. regtest venues pinning 1) > coins.DEFAULT_CONFIRMATIONS[coin].
        // A signing gate only, not signed content: no canonical/flag-day impact.
        let flatMinConf = parseInt(hubConfig.XDEX_MIN_CONFIRMATIONS || cfg.XDEX_MIN_CONFIRMATIONS);
        // Clamp an override back up to the per-coin default on mainnet and testnet, the
        // same raise-only rule coins.resolveConfirmations enforces for XCHAIN_CONFIRMATIONS_<COIN>
        // (CF-1): a lowered depth here lets this hub co-sign a match against an escrow the rest
        // of the federation still treats as reorg-able. Regtest keeps the full override.
        let _confFloored = (this.network === 'mainnet' || this.network === 'testnet');
        this.minConfirmations = {};
        for(const tick of ALLOWED_CHAINS){
            let perCoin = parseInt(process.env['XDEX_MIN_CONFIRMATIONS_' + tick] || cfg['XDEX_MIN_CONFIRMATIONS_' + tick]);
            let def = coins.DEFAULT_CONFIRMATIONS[tick] || DEFAULT_MIN_CONFIRMATIONS;
            let val = Number.isFinite(perCoin) && perCoin > 0 ? perCoin
                    : (Number.isFinite(flatMinConf) && flatMinConf > 0 ? flatMinConf
                    : def);
            if(_confFloored && val < def){
                logger.warn('[CrossChainDex] XDEX_MIN_CONFIRMATIONS' + (Number.isFinite(perCoin) && perCoin > 0 ? '_' + tick : '') +
                    '=' + val + ' is below the ' + this.network + ' floor ' + def + '; clamping to ' + def +
                    ' (confirmation overrides may only raise the depth on mainnet and testnet; ' +
                    'regtest keeps the full override)');
                val = def;
            }
            this.minConfirmations[tick] = val;
        }
    },

    // Rebuild the committed-fill ledger from finalized matches (restart safety + the
    // authoritative reservation source). Each match contributes its fill amounts to BOTH
    // legs: A gives a_amount / receives b_amount, B gives b_amount / receives a_amount.
    //
    // Builds into a LOCAL map and swaps it in only on success, so a failed rebuild can
    // never leave a cleared or half-populated ledger behind. Only the missing-table
    // condition is benign; every other failure (deadlock, lost connection, timeout on an
    // existing table) leaves the previous ledger untouched and clears the readiness flag,
    // because the old clear-then-swallow-everything shape resolved with ZERO reservations
    // and let start() proceed to matching against them. Returns true when the ledger is
    // trustworthy, so the poll tick can retry without a second timer.
    async rebuildCommitted(){
        let next = new Map();
        try {
            let rows = await this.db.findCrossChainMatchesByStatus();
            for(let r of rows) this.applyCommit(r, +1, next);
        } catch(e){
            if(!isMissingTableError(e)){
                this._committedReady = false;
                logger.error('CrossChainDex: reservation-ledger rebuild FAILED (' + ((e && e.message) || e) +
                              '); this hub proposes and co-signs NOTHING until it succeeds, ' +
                              'because an unrebuilt ledger re-offers escrow already reserved by finalized matches');
                return false;
            }
            next = new Map();   // no table yet: an empty ledger is genuinely correct
        }
        if(!this._committedReady)
            logger.info('CrossChainDex: reservation ledger rebuilt (' + next.size + ' offer legs); matching resumes');
        this.committed       = next;
        this._committedReady = true;
        return true;
    },

    offerKey(chain, actionIndex){ return chain + ':' + Number(actionIndex); },

    // Apply (sign=+1) or reverse (sign=-1) a match row's fills against both legs' ledgers.
    // `target` lets rebuildCommitted accumulate into an off-to-the-side map it only
    // installs on success; every other caller mutates the live ledger.
    applyCommit(r, sign, target){
        let ledger = target || this.committed;
        let kA = this.offerKey(r.a_chain, r.a_action_index);
        let kB = this.offerKey(r.b_chain, r.b_action_index);
        let a  = ledger.get(kA) || { give: '0', get: '0' };
        let b  = ledger.get(kB) || { give: '0', get: '0' };
        let aAmt = String(r.a_amount), bAmt = String(r.b_amount);
        let f = (sign < 0)
            ? (cur, amt) => String(bc.bcsub(cur, amt, 64))
            : (cur, amt) => String(bc.bcadd(cur, amt, 64));
        a.give = f(a.give, aAmt); a.get = f(a.get, bAmt);   // A gives a_amount, receives b_amount
        b.give = f(b.give, bAmt); b.get = f(b.get, aAmt);   // B gives b_amount, receives a_amount
        ledger.set(kA, a);
        ledger.set(kB, b);
    },

    committedFor(offer){
        return this.committed.get(this.offerKey(offer.home_coin, offer.action_index)) || { give: '0', get: '0' };
    },

    // Remaining { give, get } capacity = full offer amount − committed (never below 0).
    // For a SWAP the "full" amount is the offer amount; once matched (committed == full)
    // both sides read 0 and it drops out of matching (the Phase-A single-fill behavior).
    effectiveRemaining(offer){
        let c       = this.committedFor(offer);
        let fullGive = String(offer.give_amount != null ? offer.give_amount : '0');
        let fullGet  = String(offer.get_amount  != null ? offer.get_amount  : '0');
        let give = bc.bcsub(fullGive, c.give, 64);
        let get  = bc.bcsub(fullGet,  c.get,  64);
        return {
            give: bc.bclt(give, 0) ? '0' : String(give),
            get:  bc.bclt(get,  0) ? '0' : String(get),
            committedGive: c.give
        };
    },
};
