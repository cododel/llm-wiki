CREATE TABLE taxonomy (
  tag text PRIMARY KEY CHECK (tag ~ '^[a-z][a-z0-9-]{0,63}$'),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 1000)
);

CREATE TABLE records (
  id uuid PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('raw-source','readout','entity','concept','comparison','query','idea','note','article-draft','post-draft','meta','adr')),
  current_revision uuid,
  published_revision uuid,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE revisions (
  id uuid PRIMARY KEY,
  record_id uuid NOT NULL REFERENCES records(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,119}$'),
  body text NOT NULL,
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  original bytea,
  original_hash text CHECK (original_hash ~ '^[0-9a-f]{64}$'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  generated boolean NOT NULL DEFAULT false,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  search_en tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body)) STORED,
  search_ru tsvector GENERATED ALWAYS AS (to_tsvector('russian', title || ' ' || body)) STORED,
  UNIQUE(record_id,id),
  CHECK ((original IS NULL) = (original_hash IS NULL))
);
ALTER TABLE records ADD FOREIGN KEY(id,current_revision) REFERENCES revisions(record_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE records ADD FOREIGN KEY(id,published_revision) REFERENCES revisions(record_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX revisions_search_en ON revisions USING gin(search_en);
CREATE INDEX revisions_search_ru ON revisions USING gin(search_ru);
CREATE INDEX revisions_record ON revisions(record_id);

CREATE TABLE revision_tags (
  revision_id uuid NOT NULL REFERENCES revisions(id),
  tag text NOT NULL REFERENCES taxonomy(tag),
  PRIMARY KEY(revision_id,tag)
);
CREATE TABLE relations (
  revision_id uuid NOT NULL REFERENCES revisions(id),
  target_id uuid NOT NULL REFERENCES records(id),
  kind text NOT NULL CHECK (kind IN ('related','supports','contradicts','supersedes')),
  PRIMARY KEY(revision_id,target_id,kind)
);
CREATE TABLE provenance (
  id uuid PRIMARY KEY,
  revision_id uuid NOT NULL REFERENCES revisions(id),
  source_revision uuid REFERENCES revisions(id),
  external_url text,
  CHECK ((source_revision IS NOT NULL)::integer + (external_url IS NOT NULL)::integer = 1)
);
CREATE TABLE blobs (
  hash text PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{64}$'),
  size bigint NOT NULL CHECK(size > 0),
  media_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE revision_blobs (
  revision_id uuid NOT NULL REFERENCES revisions(id),
  hash text NOT NULL REFERENCES blobs(hash),
  PRIMARY KEY(revision_id,hash)
);
CREATE TABLE publication_requests (
  id uuid PRIMARY KEY,
  record_id uuid NOT NULL REFERENCES records(id),
  revision_id uuid NOT NULL REFERENCES revisions(id),
  attachments jsonb NOT NULL DEFAULT '[]',
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','stale','withdrawn')),
  requested_by text NOT NULL,
  approved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 day'
);
CREATE TABLE published_blobs (
  record_id uuid NOT NULL REFERENCES records(id),
  hash text NOT NULL REFERENCES blobs(hash),
  PRIMARY KEY(record_id,hash)
);
CREATE TABLE audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE idempotency (
  actor text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  PRIMARY KEY(actor,key)
);
CREATE TABLE instance_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);
CREATE FUNCTION reject_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable history'; END;
$$;
CREATE TRIGGER revisions_immutable BEFORE UPDATE OR DELETE ON revisions FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER revision_tags_immutable BEFORE UPDATE OR DELETE ON revision_tags FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER relations_immutable BEFORE UPDATE OR DELETE ON relations FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER provenance_immutable BEFORE UPDATE OR DELETE ON provenance FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER revision_blobs_immutable BEFORE UPDATE OR DELETE ON revision_blobs FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
