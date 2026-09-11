-- Product-owned schema. Instance organization never executes DDL.
ALTER TABLE records ADD COLUMN kind text NOT NULL DEFAULT 'record'
  CHECK(kind IN ('record','source','skill'));
UPDATE records SET kind='source' WHERE type='raw-source';
ALTER TABLE records ADD COLUMN edit_locked boolean NOT NULL DEFAULT false;
ALTER TABLE records ADD COLUMN lock_version integer NOT NULL DEFAULT 0 CHECK(lock_version >= 0);

CREATE TABLE sources (
  record_id uuid PRIMARY KEY REFERENCES records(id)
);
INSERT INTO sources SELECT id FROM records WHERE kind='source';
CREATE TABLE skills (
  record_id uuid PRIMARY KEY REFERENCES records(id)
);

CREATE TABLE revision_details (
  revision_id uuid PRIMARY KEY REFERENCES revisions(id),
  native boolean NOT NULL DEFAULT false,
  legacy_revision uuid REFERENCES revisions(id),
  maturity text CHECK(maturity IN ('seed','growing','evergreen')),
  check_policy text NOT NULL CHECK(check_policy IN ('automatic','manual'))
);
CREATE TABLE legacy_backfill_pending (revision_id uuid PRIMARY KEY REFERENCES revisions(id));
INSERT INTO legacy_backfill_pending SELECT id FROM revisions;

CREATE TABLE skill_revisions (
  revision_id uuid PRIMARY KEY REFERENCES revisions(id),
  description text NOT NULL CHECK(length(description) BETWEEN 1 AND 1024),
  use_when text NOT NULL CHECK(length(use_when) BETWEEN 1 AND 5000),
  avoid_when text NOT NULL DEFAULT '' CHECK(length(avoid_when)<=5000),
  requirements text[] NOT NULL DEFAULT '{}'
);
CREATE TABLE skill_dependencies (
  revision_id uuid NOT NULL REFERENCES skill_revisions(revision_id),
  target_revision uuid NOT NULL REFERENCES revisions(id),
  required boolean NOT NULL DEFAULT true,
  PRIMARY KEY(revision_id,target_revision)
);
CREATE TABLE revision_skill_links (
  revision_id uuid NOT NULL REFERENCES revisions(id),
  skill_id uuid NOT NULL REFERENCES skills(record_id),
  PRIMARY KEY(revision_id,skill_id)
);
CREATE TABLE derivations (
  revision_id uuid NOT NULL REFERENCES revisions(id),
  target_revision uuid NOT NULL REFERENCES revisions(id),
  kind text NOT NULL CHECK(kind IN ('derived_from','used_skill')),
  PRIMARY KEY(revision_id,target_revision,kind),
  CHECK(revision_id<>target_revision)
);
CREATE INDEX derivations_reverse ON derivations(target_revision,revision_id);
CREATE INDEX skill_links_reverse ON revision_skill_links(skill_id,revision_id);

CREATE TABLE terms (
  id uuid PRIMARY KEY,
  vocabulary text NOT NULL CHECK(vocabulary IN ('topic','format')),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  aliases text[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  archived boolean NOT NULL DEFAULT false,
  UNIQUE(id,vocabulary)
);
CREATE TABLE revision_terms (
  revision_id uuid NOT NULL REFERENCES revisions(id),
  term_id uuid NOT NULL,
  vocabulary text NOT NULL,
  name text NOT NULL,
  aliases text[] NOT NULL,
  PRIMARY KEY(revision_id,term_id),
  FOREIGN KEY(term_id,vocabulary) REFERENCES terms(id,vocabulary)
);
CREATE UNIQUE INDEX revision_one_format ON revision_terms(revision_id) WHERE vocabulary='format';
CREATE INDEX revision_terms_lookup ON revision_terms(term_id,revision_id);
CREATE TABLE legacy_term_map (
  tag text PRIMARY KEY REFERENCES taxonomy(tag),
  term_id uuid NOT NULL UNIQUE REFERENCES terms(id)
);
INSERT INTO terms(id,vocabulary,name)
  SELECT md5('llm-wiki:legacy-tag:'||tag)::uuid,'topic',tag FROM taxonomy;
INSERT INTO legacy_term_map SELECT tag,md5('llm-wiki:legacy-tag:'||tag)::uuid FROM taxonomy;
INSERT INTO terms(id,vocabulary,name)
  SELECT md5('llm-wiki:legacy-format:'||type)::uuid,'format',type FROM records WHERE kind='record' GROUP BY type;

CREATE TABLE collections (
  id uuid PRIMARY KEY,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 300),
  archived boolean NOT NULL DEFAULT false
);
CREATE TABLE collection_members (
  collection_id uuid NOT NULL REFERENCES collections(id),
  record_id uuid NOT NULL REFERENCES records(id),
  position integer NOT NULL CHECK(position>=0),
  PRIMARY KEY(collection_id,record_id),
  UNIQUE(collection_id,position)
);
CREATE INDEX collection_members_reverse ON collection_members(record_id,collection_id);

-- Legacy writes obtain fixed-model defaults without modifying historical snapshots.
CREATE FUNCTION initialize_record_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type='raw-source' THEN NEW.kind='source'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER record_kind BEFORE INSERT ON records FOR EACH ROW EXECUTE FUNCTION initialize_record_kind();
CREATE FUNCTION initialize_record_extension() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='source' THEN INSERT INTO sources VALUES(NEW.id); END IF;
  IF NEW.kind='skill' THEN INSERT INTO skills VALUES(NEW.id); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER record_extension AFTER INSERT ON records FOR EACH ROW EXECUTE FUNCTION initialize_record_extension();
CREATE FUNCTION initialize_revision_details() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO revision_details(revision_id,native,maturity,check_policy) SELECT NEW.id,false,NULL,
    CASE WHEN r.kind<>'record' OR r.type IN ('meta','adr') OR NEW.generated THEN 'manual' ELSE 'automatic' END
    FROM records r WHERE r.id=NEW.record_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revision_details_default AFTER INSERT ON revisions FOR EACH ROW EXECUTE FUNCTION initialize_revision_details();

CREATE FUNCTION protect_revision_extension() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Only the product-owned, pending historical projection may add new extension rows.
  -- No accepted source/revision or existing edge can be altered by backfill.
  IF TG_OP='INSERT' AND TG_TABLE_NAME IN ('revision_details','revision_terms')
    AND EXISTS(SELECT 1 FROM legacy_backfill_pending WHERE revision_id=NEW.revision_id) THEN RETURN NEW; END IF;
  IF TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM revision_seals WHERE revision_id=OLD.revision_id) THEN
    RAISE EXCEPTION 'immutable revision extension';
  END IF;
  IF TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM revision_seals WHERE revision_id=NEW.revision_id) THEN
    RAISE EXCEPTION 'immutable revision extension';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER details_sealed BEFORE INSERT OR UPDATE OR DELETE ON revision_details FOR EACH ROW EXECUTE FUNCTION protect_revision_extension();
CREATE TRIGGER skill_revision_sealed BEFORE INSERT OR UPDATE OR DELETE ON skill_revisions FOR EACH ROW EXECUTE FUNCTION protect_revision_extension();
CREATE TRIGGER skill_dependencies_sealed BEFORE INSERT OR UPDATE OR DELETE ON skill_dependencies FOR EACH ROW EXECUTE FUNCTION protect_revision_extension();
CREATE TRIGGER skill_links_sealed BEFORE INSERT OR UPDATE OR DELETE ON revision_skill_links FOR EACH ROW EXECUTE FUNCTION protect_revision_extension();
CREATE TRIGGER derivations_sealed BEFORE INSERT OR UPDATE OR DELETE ON derivations FOR EACH ROW EXECUTE FUNCTION protect_revision_extension();
CREATE TRIGGER terms_sealed BEFORE INSERT OR UPDATE OR DELETE ON revision_terms FOR EACH ROW EXECUTE FUNCTION protect_revision_extension();

-- Navigation semantics are fixed by this release, never registered by an agent.
ALTER TABLE relations DROP CONSTRAINT relations_kind_check;
ALTER TABLE relations ADD CHECK(kind IN ('related','supports','contradicts','supersedes','about','part_of'));

CREATE FUNCTION protect_record_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind<>OLD.kind OR NEW.type<>OLD.type THEN RAISE EXCEPTION 'immutable record kind'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_record_kind BEFORE UPDATE OF kind,type ON records FOR EACH ROW EXECUTE FUNCTION protect_record_kind();
