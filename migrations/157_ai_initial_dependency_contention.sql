-- Connection administration uses Connection -> Branch, while real intake already owns Branch after Routing.
-- A bounded local assessment must not turn an AI dependency lock race into loss of a trusted core Lead.
ALTER FUNCTION ai_initial_locked_context(uuid,timestamptz) RENAME TO ai_initial_waiting_context;
CREATE FUNCTION ai_initial_locked_context(rid uuid,at_time timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE previous_timeout text;ctx jsonb;BEGIN
 previous_timeout=current_setting('lock_timeout');
 BEGIN
  PERFORM set_config('lock_timeout','100ms',true);
  ctx=ai_initial_waiting_context(rid,at_time);
  PERFORM set_config('lock_timeout',previous_timeout,true);RETURN ctx;
 EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
  -- The subtransaction releases dependency locks and restores the caller's timeout. No external I/O occurred.
  RETURN NULL;
 END;
END $$;
CREATE OR REPLACE FUNCTION guard_ai_initial_admission() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE r record;ctx jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'AI_INITIAL_ADMISSION_IMMUTABLE';END IF;
 SELECT ir.*,ir.xmin AS row_xid INTO r FROM lead_intake_receipt ir JOIN lead_intake_birth bi ON bi.lead_id=ir.lead_id AND ai_row_inserted_here(bi.xmin) WHERE ir.id=NEW.receipt_id;
 IF r IS NULL OR NOT ai_row_inserted_here(r.row_xid) THEN RAISE EXCEPTION 'AI_INITIAL_FRESH_INTAKE_REQUIRED';END IF;
 IF NOT EXISTS(SELECT 1 FROM lead l JOIN campaign c ON c.id=l.campaign_id WHERE l.id=r.lead_id AND c.ai_config->>'enabled'='true') THEN RAISE EXCEPTION 'AI_INITIAL_ENABLED_SOURCE_REQUIRED';END IF;
 NEW.created_at=clock_timestamp();ctx=ai_initial_locked_context(NEW.receipt_id,NEW.created_at);
 IF ctx IS NULL THEN
  -- No claim about configuration, Profile, Knowledge, Sender or availability was obtained. This can never grant authority.
  ctx=jsonb_build_object('schema',1,'kind','LEAD_INTAKE_INITIAL','scope',r.context->'scope','dependencyBusy',true,
   'source',jsonb_build_object('receiptId',r.id,'originKind',r.origin_kind,'submissionId',r.submission_id,'routingHistoryId',r.routing_history_id),
   'availability',jsonb_build_object('ownerAvailable',NULL),'sendAuthorized',false,'liveTransferEnabled',false);
  NEW.blockers='["AI_INITIAL_DEPENDENCY_BUSY"]';NEW.state='BLOCKED';
 ELSE
  NEW.blockers=ai_initial_admission_blockers(ctx);NEW.state=CASE WHEN NEW.blockers='[]' THEN 'ADMITTED' ELSE 'BLOCKED' END;
 END IF;
 NEW.context=ctx;NEW.context_hash=encode(sha256(convert_to(ctx::text,'UTF8')),'hex');RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION prove_ai_initial_admission() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE r lead_intake_receipt;BEGIN
 IF NEW.context->>'dependencyBusy'='true' THEN
  SELECT * INTO r FROM lead_intake_receipt WHERE id=NEW.receipt_id;
  IF NEW.state<>'BLOCKED' OR NEW.blockers<>'["AI_INITIAL_DEPENDENCY_BUSY"]' OR NEW.context->'scope' IS DISTINCT FROM r.context->'scope'
   OR NEW.context->'source'->>'receiptId' IS DISTINCT FROM r.id::text THEN RAISE EXCEPTION 'AI_INITIAL_BLOCKED_SOURCE_REQUIRED';END IF;
 ELSIF ai_initial_intake_context(NEW.receipt_id,NEW.created_at) IS DISTINCT FROM NEW.context THEN RAISE EXCEPTION 'AI_INITIAL_ATOMIC_CONTEXT_REQUIRED';END IF;RETURN NEW;
END $$;
