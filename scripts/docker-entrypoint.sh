#!/bin/sh
set -eu

cd /app
: "${COURSES_PATH:=/srv/courses}"
: "${AUTH_PATH:=/srv/auth}"
: "${GENERATED_DIR:=/app/generated}"
: "${NGINX_CONFIG_PATH:=/etc/nginx/conf.d/default.conf}"
: "${SITE_ROOT:=/tmp/education-site}"
: "${RUNTIME_COURSES_PATH:=/srv/courses}"
: "${RUNTIME_AUTH_PATH:=/srv/auth}"
export COURSES_PATH AUTH_PATH GENERATED_DIR NGINX_CONFIG_PATH SITE_ROOT
export RUNTIME_COURSES_PATH RUNTIME_AUTH_PATH

node scripts/prepare-content.mjs
node node_modules/@docusaurus/core/bin/docusaurus.mjs build --out-dir "$SITE_ROOT"
node scripts/auth-server.mjs &
exec nginx -g 'daemon off;'
