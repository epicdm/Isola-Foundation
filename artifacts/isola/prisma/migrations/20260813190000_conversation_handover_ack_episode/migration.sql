-- Additive only: one nullable column, no default, no index, no constraint,
-- no backfill. NULL means "no acknowledgement has been sent for any episode
-- on this conversation", which is the correct reading for every existing row.
--
-- Holds the ownership_episode an automated handover acknowledgement was sent
-- for. The send is claimed with a conditional UPDATE on this column before the
-- message is posted, so two concurrent inbound messages cannot both send one.
ALTER TABLE "Conversation" ADD COLUMN "handover_ack_episode" INTEGER;
