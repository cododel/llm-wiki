CREATE TABLE browser_flows (
  state_hash text PRIMARY KEY,
  nonce text NOT NULL,
  verifier text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE TABLE browser_sessions (
  id_hash text PRIMARY KEY,
  encrypted_tokens text NOT NULL,
  csrf text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '8 hours'
);
