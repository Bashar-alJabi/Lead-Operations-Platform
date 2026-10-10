-- Keep applied migration checksums; remove the PL/pgSQL record/table alias collision.
CREATE OR REPLACE FUNCTION guard_messaging_inbound_authentication() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE source_row record;BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'INBOUND_AUTHENTICATION_IMMUTABLE';END IF;
  SELECT ev.payload,ev.event_kind,c.provider INTO source_row FROM integration_event ev JOIN integration_connection c ON c.id=ev.connection_id WHERE ev.id=NEW.event_id;
  IF NOT FOUND OR source_row.event_kind<>'INBOUND_MESSAGE' OR source_row.provider<>'META_WHATSAPP_CLOUD' THEN RAISE EXCEPTION 'INBOUND_AUTHENTICATION_SOURCE_REQUIRED';END IF;
  NEW.payload_sha256=encode(sha256(convert_to(source_row.payload::text,'UTF8')),'hex');
  NEW.verified_at=clock_timestamp();RETURN NEW;
END $$;
