-- Cross-chain contract call relay rows (XCALL). Two immutable phases per call,
-- both quorum-signed by the cross_chain capability set and mirrored to every
-- indexer over the hub-DB channel (same transport as cross_chain_matches):
--   dispatch — federation-confirmed request from the source chain; target-chain
--              indexers verify the signatures and inject the execution at the
--              first block with block_time >= effective_time.
--   result   — federation-confirmed execution outcome from the target chain;
--              source-chain indexers verify and inject the requester's callback.
-- The hub-assigned `id` is BOTH the mirror cursor and the indexers'
-- deterministic injection-order key (ORDER BY id ASC) — never reorder.
DROP TABLE IF EXISTS cross_chain_calls;
CREATE TABLE cross_chain_calls (
    id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, -- mirror cursor (since_id) + injection-order key
    call_id               VARCHAR(80)  NOT NULL,                   -- deterministic id derived in the source-chain VM run
    phase                 VARCHAR(10)  NOT NULL,                   -- 'dispatch' | 'result'
    snapshot_block        BIGINT UNSIGNED NOT NULL,                -- BTC-anchored block; selects the cross_chain validator set for sig verification
    network               VARCHAR(20)  NOT NULL,                   -- mainnet/testnet/regtest; signed into the canonical
    source_chain          VARCHAR(10)  NOT NULL,
    source_action_index   BIGINT UNSIGNED NOT NULL,                -- the on-chain XCALL v0 request row (retraction key)
    source_contract_index BIGINT UNSIGNED NOT NULL,
    target_chain          VARCHAR(10)  NOT NULL,
    target_contract_index BIGINT UNSIGNED NOT NULL,
    method                VARCHAR(64)  NOT NULL,
    params_json           TEXT         NOT NULL,                   -- JSON array of string params (sha256'd into the canonical)
    gas_limit             BIGINT UNSIGNED NOT NULL,                -- caller-funded target-side gas ceiling
    cross_hops            INT          NOT NULL DEFAULT 0,         -- X→Y→X ping-pong bound (signed into the canonical)
    effective_time        BIGINT UNSIGNED NOT NULL,                -- apply at first block_time >= this (dispatch: target chain; result: source chain)
    finalizing_view       INT          NOT NULL DEFAULT 0,         -- PBFT view the round finalized at; signed into the EQUIV canonical (WI-2 bump 2) so the indexer rebuilds the exact view
    status                VARCHAR(20)  NOT NULL DEFAULT 'finalized',-- row lifecycle: finalized / retracted (same model as cross_chain_matches)
    result_status         VARCHAR(20),                             -- result phase only: ok|reverted|out_of_gas|no_contract|not_callable|payload_too_large|error
    return_payload_b64    TEXT,                                    -- result phase only (sha256'd into the canonical)
    validator_signatures  TEXT         NOT NULL,                   -- JSON [{pubkey, sig}] — 2f+1 Ed25519 over the phase canonical
    batch_seq             BIGINT UNSIGNED,                         -- ANCHOR archive batch this row was committed in; hub-side only
    archived_status       VARCHAR(20),                             -- status at archive publish (re-archive when it drifts); hub-side only
    anchor_txid           VARCHAR(80),                             -- DOGE txid of the archiving ANCHOR; hub-side audit, not mirrored
    created_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX call_phase     ON cross_chain_calls (call_id, phase);
CREATE        INDEX source_ref     ON cross_chain_calls (source_chain, source_action_index);
CREATE        INDEX target_ref     ON cross_chain_calls (target_chain, phase);
CREATE        INDEX effective_time ON cross_chain_calls (effective_time);
CREATE        INDEX status         ON cross_chain_calls (status);
CREATE        INDEX batch_seq      ON cross_chain_calls (batch_seq);
