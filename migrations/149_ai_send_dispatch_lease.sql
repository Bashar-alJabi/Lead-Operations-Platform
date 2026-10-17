-- Parent/context waits may outlive a claimed lease. Never let an expired AI claimant prepare provider I/O.
CREATE FUNCTION guard_ai_send_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE m record;BEGIN
 SELECT * INTO m FROM conversation_message WHERE id=NEW.message_id;
 IF m.ai_send_action_id IS NULL THEN RETURN NEW;END IF;
 IF NEW.state<>'PREPARED' OR NEW.provider_message_id IS NOT NULL OR NEW.error_code IS NOT NULL OR NEW.finished_at IS NOT NULL
   OR m.delivery_state<>'QUEUED' OR ai_customer_send_dispatch_context(m.ai_send_action_id) IS NULL
   THEN RAISE EXCEPTION 'AI_SEND_CURRENT_ATTEMPT_REQUIRED';END IF;
 -- Current text adapter aborts HTTP at 10s. This technical margin reserves 15s, not a business/provider limit.
 -- The Job lock also fences a concurrent expired-lease claimant until PREPARED becomes visible.
 PERFORM 1 FROM background_job j JOIN outbound_delivery_job link ON link.job_id=j.id JOIN sender_outbound_lease lease ON lease.job_id=j.id
   WHERE link.message_id=m.id AND j.id=NEW.job_id AND j.queue='messaging' AND j.kind='SEND_MESSAGE'
     AND j.status='RUNNING' AND j.attempts=NEW.attempt_number AND j.locked_until>clock_timestamp()+interval '15 seconds'
     AND lease.sender_id=m.sender_id AND lease.locked_until>clock_timestamp()+interval '15 seconds'
   FOR KEY SHARE OF j;
 IF NOT FOUND THEN RAISE EXCEPTION 'AI_SEND_CURRENT_DISPATCH_LEASE_REQUIRED';END IF;
 NEW.started_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER ai_send_attempt_guard BEFORE INSERT ON outbound_send_attempt FOR EACH ROW EXECUTE FUNCTION guard_ai_send_attempt();
