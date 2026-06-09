/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - Merkle Tree
 *
 * Pure binary SHA-256 Merkle tree (no external deps). Used by the cross-chain
 * DEX DOGE audit anchor (CrossChainDexAnchor) to commit a batch of finalized
 * matches to a single root.
 *
 * DELIBERATE DUPLICATE of xchain-sync/src/MerkleTree.js — identical convention
 * (sha256 over hex-string concat, duplicate-last on odd width) so a verifier can
 * reconstruct either service's roots the same way. The two services are
 * independently deployed (xchain-sync is not a hub dependency), so the ~60-line
 * pure util is copied rather than shared. Keep the two in sync if the convention
 * changes.
 *
 ********************************************************************/

const crypto = require('crypto');

class MerkleTree {

    // Hash two nodes together (internal node). left/right are hex strings.
    static hashPair(left, right) {
        return crypto.createHash('sha256').update(left + right).digest('hex');
    }

    // Build a Merkle tree from an array of leaf hashes (hex strings).
    // Returns { root, layers } where layers[0] = leaves, layers[last] = [root].
    // Odd layers duplicate the last node (Bitcoin-style). Empty → { root: null }.
    static buildTree(leaves) {
        if (!leaves || leaves.length === 0) return { root: null, layers: [] };

        let layers = [leaves.slice()];
        let current = leaves.slice();
        while (current.length > 1) {
            let next = [];
            for (let i = 0; i < current.length; i += 2) {
                let left  = current[i];
                let right = (i + 1 < current.length) ? current[i + 1] : left; // duplicate last if odd
                next.push(MerkleTree.hashPair(left, right));
            }
            layers.push(next);
            current = next;
        }
        return { root: current[0], layers: layers };
    }

    // Convenience: the root for a set of leaves (or null when empty).
    static root(leaves) {
        return MerkleTree.buildTree(leaves).root;
    }

    // Inclusion proof for the leaf at leafIndex — array of { hash, position }.
    static generateProof(layers, leafIndex) {
        if (!layers || layers.length === 0 || leafIndex < 0 || leafIndex >= layers[0].length) return null;
        let proof = [];
        let index = leafIndex;
        for (let i = 0; i < layers.length - 1; i++) {
            let layer = layers[i];
            let isRight = index % 2 === 1;
            let siblingIndex = isRight ? index - 1 : index + 1;
            if (siblingIndex < layer.length) {
                proof.push({ hash: layer[siblingIndex], position: isRight ? 'left' : 'right' });
            } else {
                proof.push({ hash: layer[index], position: 'right' });  // odd node — sibling is self
            }
            index = Math.floor(index / 2);
        }
        return proof;
    }

    // Verify an inclusion proof reconstructs expectedRoot.
    static verifyProof(leaf, proof, expectedRoot) {
        if (!leaf || !proof || !expectedRoot) return false;
        let current = leaf;
        for (let step of proof) {
            current = (step.position === 'left')
                ? MerkleTree.hashPair(step.hash, current)
                : MerkleTree.hashPair(current, step.hash);
        }
        return current === expectedRoot;
    }
}

module.exports = MerkleTree;
