-- Restate enum, voting-window and provider-payload columns on an already-deployed hub.
-- xchain:migration mode=manual

ALTER TABLE `validator_capabilities` MODIFY `capability` ENUM('price','cross_chain','oracle_publish','attestation','full_node') NOT NULL;
ALTER TABLE `governance_proposals` MODIFY `voting_start` DATETIME NOT NULL;
ALTER TABLE `governance_proposals` MODIFY `voting_end` DATETIME NOT NULL;
ALTER TABLE `attestation_responses` MODIFY `response_payload` MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
ALTER TABLE `attestation_responses` MODIFY `meta` TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
