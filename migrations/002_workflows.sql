CREATE TABLE campaigns (
  id uuid PRIMARY KEY,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK(kind IN ('factcheck','review')),
  campaign_id uuid REFERENCES campaigns(id),
  target_id uuid NOT NULL REFERENCES records(id),
  revision_id uuid NOT NULL REFERENCES revisions(id),
  fingerprint text NOT NULL,
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','complete','blocked','failed')),
  executor text,
  claim_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  progress jsonb,
  result jsonb,
  result_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX jobs_incremental_dedup ON jobs(target_id,fingerprint) WHERE kind='factcheck';
CREATE UNIQUE INDEX jobs_review_dedup ON jobs(campaign_id,target_id) WHERE kind='review';
CREATE INDEX jobs_queue ON jobs(kind,state,available_at);
CREATE TABLE checkpoints (
  target_id uuid NOT NULL REFERENCES records(id),
  fingerprint text NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id),
  PRIMARY KEY(target_id,fingerprint)
);
CREATE TABLE events (
  id uuid PRIMARY KEY,
  job_id uuid REFERENCES jobs(id),
  kind text NOT NULL,
  detail jsonb NOT NULL,
  acknowledged_by text,
  acknowledged_at timestamptz,
  resolved_by text,
  resolved_at timestamptz,
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  channel text NOT NULL CHECK(channel IN ('factcheck','review','notification')),
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','delivered','failed')),
  lease_token uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
