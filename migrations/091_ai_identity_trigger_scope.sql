-- Preserve the established PAYMENT identity fence/error for PAYMENT -> AI.
-- AI origins and other -> AI transitions still cannot change historical identity.
DROP TRIGGER ai_connection_identity_guard ON integration_connection;
CREATE TRIGGER ai_connection_identity_guard BEFORE UPDATE ON integration_connection FOR EACH ROW
  WHEN (OLD.kind='AI' OR (NEW.kind='AI' AND OLD.kind<>'PAYMENT')) EXECUTE FUNCTION guard_ai_connection_identity();
