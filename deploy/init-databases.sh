#!/bin/sh
set -eu
# This hook runs only against a new PostgreSQL data volume.
wiki_password=$(cat /run/secrets/wiki_db_password)
auth_password=$(cat /run/secrets/auth_db_password)
psql --username "$POSTGRES_USER" --dbname postgres --set=ON_ERROR_STOP=1 \
  --set=wiki_password="$wiki_password" --set=auth_password="$auth_password" <<'SQL'
CREATE ROLE wiki LOGIN PASSWORD :'wiki_password';
CREATE ROLE authelia LOGIN PASSWORD :'auth_password';
CREATE DATABASE wiki OWNER wiki;
CREATE DATABASE authelia OWNER authelia;
REVOKE ALL ON DATABASE wiki FROM PUBLIC;
REVOKE ALL ON DATABASE authelia FROM PUBLIC;
GRANT CONNECT ON DATABASE wiki TO wiki;
GRANT CONNECT ON DATABASE authelia TO authelia;
SQL
