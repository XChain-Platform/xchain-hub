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
 * XChain Hub - Peer Consensus Rules
 *
 * What each peer says its consensus rules are, the two alarms a
 * disagreement raises (the peer is odd, or THIS hub is), and the
 * operator-facing snapshot of the comparison.
 *
 ********************************************************************/

const rulesDigest = require('../../consensus_rules_digest.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

class PeerRules {

// Record a peer's advertised consensus rules and raise the two alarms this
    // module exists for. Called only after verifySignature passed, so `sender` is
    // an authenticated staked key and `data.rules` is covered by that signature.
    //
    // TWO ALARMS, and the second is the one that matters. Telling an operator that
    // some peer disagrees is mildly useful; telling them that THEIR OWN hub is the
    // odd one out is the message that gets a node upgraded, and it is the message
    // nothing in the platform sent before this.
    notePeerRules(envelope) {
        let sender = envelope && envelope.sender;
        if (!sender) return;
        let data   = envelope.data || {};
        let digest = (typeof data.rules === 'string' && /^[0-9a-f]{64}$/.test(data.rules)) ? data.rules : null;
        this.peerRules.set(sender, {
            digest:  digest,
            version: (typeof data.version === 'string') ? data.version : null,
            at:      Date.now()
        });

        let mine = rulesDigest.computeConsensusRulesDigest().digest;

        // A peer that advertises no digest is running a build from before this field
        // existed. That is worth saying once per throttle window, but it is NOT a
        // mismatch: it carries no claim to disagree with.
        if (digest === null) {
            this.warnRulesOnce('legacy:' + sender, 'P2P: peer ' + sender + ' advertises no consensus-rules digest' +
                ' (version ' + (this.peerRules.get(sender).version || 'unknown') + '); it predates the digest and cannot be' +
                ' checked for flag-day agreement. Ask its operator to upgrade.');
            return;
        }
        if (digest === mine) return;

        this.warnRulesOnce('peer:' + sender, 'P2P: CONSENSUS-RULE MISMATCH with peer ' + sender +
            ' (its version ' + (this.peerRules.get(sender).version || 'unknown') + '). It applies different flag-day' +
            ' heights than this hub, so the two will disagree about which actions are valid once a differing gate is' +
            ' reached. peer=' + digest.substring(0, 16) + '... ours=' + mine.substring(0, 16) + '...');

        // Am I the minority? Count DISTINCT senders seen inside the staleness window,
        // so a peer that has gone away stops voting. Strictly more peers agreeing with
        // each other than with me means this hub is the one that needs upgrading.
        let cutoff = Date.now() - (2 * (parseInt(this.config.P2P_HEARTBEAT_INTERVAL) || 15000) * 4);
        let tally = new Map();
        let live  = 0;
        for (let [, r] of this.peerRules) {
            if (!r || !r.digest || r.at < cutoff) continue;
            live++;
            tally.set(r.digest, (tally.get(r.digest) || 0) + 1);
        }
        if (live === 0) return;
        let topDigest = null, topCount = 0;
        for (let [d, n] of tally) if (n > topCount) { topCount = n; topDigest = d; }
        let mineCount = (tally.get(mine) || 0) + 1;   // +1: this hub's own vote
        if (topDigest && topDigest !== mine && topCount >= mineCount) {
            this.warnRulesOnce('self', 'P2P: THIS HUB IS RUNNING CONSENSUS RULES THE FEDERATION DOES NOT SHARE. ' +
                topCount + ' of ' + (live + 1) + ' peers agree on ' + topDigest.substring(0, 16) + '... while this hub has ' +
                mine.substring(0, 16) + '... Once the chain reaches a gate where they differ, this hub will judge actions' +
                ' differently from the federation and its state will diverge. UPGRADE THIS NODE.');
        }
    }

    warnRulesOnce(key, message) {
        let now  = Date.now();
        let last = this._rulesWarnedAt.get(key) || 0;
        if (now - last < this.rulesWarnIntervalMs) return;
        this._rulesWarnedAt.set(key, now);
        logger.warn(message);
    }

    // Snapshot for the operator-facing surfaces (hub status / health). `agree` is the
    // count of live peers on this hub's own digest, so a monitor can alarm on it
    // without re-deriving the comparison.
    getConsensusRulesReport() {
        let mine = rulesDigest.computeConsensusRulesDigest();
        let peers = [];
        for (let [addr, r] of this.peerRules) {
            peers.push({ peer: addr, digest: r.digest, version: r.version, at: r.at,
                         agrees: r.digest === mine.digest });
        }
        return {
            digest:    mine.digest,
            gates:     mine.gates,
            peers:     peers,
            agree:     peers.filter(p => p.agrees).length,
            disagree:  peers.filter(p => p.digest && !p.agrees).length,
            unknown:   peers.filter(p => !p.digest).length
        };
    }
}

module.exports = PeerRules;
