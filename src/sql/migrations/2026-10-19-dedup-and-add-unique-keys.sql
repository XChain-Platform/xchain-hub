-- Deduplicate deployed tables before adding their runtime unique keys.
-- xchain:migration mode=manual
-- Each DELETE keeps the lowest id in its duplicate set.

DELETE t1 FROM oracle_submissions t1 INNER JOIN oracle_submissions t2 WHERE t1.id > t2.id AND t1.round_number = t2.round_number AND t1.coin_pair = t2.coin_pair AND t1.validator_pubkey = t2.validator_pubkey;
ALTER TABLE `oracle_submissions` ADD UNIQUE KEY IF NOT EXISTS `uq_submission` (round_number, coin_pair, validator_pubkey);
DELETE t1 FROM validator_rewards t1 INNER JOIN validator_rewards t2 WHERE t1.id > t2.id AND t1.validator_pubkey = t2.validator_pubkey AND t1.round_number = t2.round_number AND t1.reward_type = t2.reward_type AND t1.round_qualifier = t2.round_qualifier;
ALTER TABLE `validator_rewards` ADD UNIQUE KEY IF NOT EXISTS `uq_reward` (validator_pubkey, round_number, reward_type, round_qualifier);
DELETE t1 FROM state_checkpoints t1 INNER JOIN state_checkpoints t2 WHERE t1.id > t2.id AND t1.chain = t2.chain AND t1.network = t2.network AND t1.checkpoint_seq = t2.checkpoint_seq;
ALTER TABLE `state_checkpoints` ADD UNIQUE KEY IF NOT EXISTS `uq_chain_seq` (chain, network, checkpoint_seq);
