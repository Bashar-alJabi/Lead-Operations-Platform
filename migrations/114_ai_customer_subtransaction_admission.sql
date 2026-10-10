-- Inbound processing uses SAVEPOINT. xmin may be a child transaction, not the top-level ID.
-- A row visible to this transaction with an in-progress inserting xid can only be our own write.
-- Extend xmin relative to the current top-level xid, including a child crossing the 32-bit wrap.
CREATE OR REPLACE FUNCTION guard_ai_customer_new_inbound_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inserted_xid numeric;top_xid numeric;low_top numeric;full_xid xid8;BEGIN
 SELECT e.xmin::text::numeric INTO inserted_xid FROM ai_customer_inbound_execution e WHERE e.event_id=NEW.event_id AND e.message_id=NEW.message_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'AI_CUSTOMER_PROPOSAL_SOURCE_REQUIRED';END IF;
 top_xid=pg_current_xact_id()::text::numeric;low_top=mod(top_xid,4294967296);
 full_xid=(top_xid-low_top+inserted_xid+CASE WHEN inserted_xid<low_top THEN 4294967296 ELSE 0 END)::text::xid8;
 IF pg_xact_status(full_xid) IS DISTINCT FROM 'in progress' THEN RAISE EXCEPTION 'AI_CUSTOMER_PROPOSAL_SOURCE_REQUIRED';END IF;RETURN NEW;
EXCEPTION WHEN others THEN RAISE EXCEPTION 'AI_CUSTOMER_PROPOSAL_SOURCE_REQUIRED';END $$;
