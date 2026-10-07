-- SQL CHECK accepts NULL expressions; an encrypted secret must include an explicit key version.
ALTER TABLE payment_webhook DROP CONSTRAINT payment_webhook_secret_shape_check;
ALTER TABLE payment_webhook ADD CONSTRAINT payment_webhook_secret_shape_check
  CHECK((ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL AND key_version IS NULL) OR
    (external_endpoint_id IS NOT NULL AND ciphertext IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL AND key_version IS NOT NULL
      AND key_version=1 AND octet_length(nonce)=12 AND octet_length(auth_tag)=16));
