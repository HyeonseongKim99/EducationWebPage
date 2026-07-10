FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM nginx:1.28-alpine
RUN rm -f /etc/nginx/conf.d/default.conf
WORKDIR /app
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=dependencies /usr/lib/libstdc++.so.6 /usr/lib/libstdc++.so.6
COPY --from=dependencies /usr/lib/libgcc_s.so.1 /usr/lib/libgcc_s.so.1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN chmod +x scripts/docker-entrypoint.sh \
    && mkdir -p /srv/site /srv/courses /srv/auth \
    && COURSES_PATH=/app/course-template \
       AUTH_PATH=/app/auth-template \
       GENERATED_DIR=/app/generated \
       NGINX_CONFIG_PATH=/tmp/nginx.conf \
       SITE_ROOT=/tmp/site \
       node scripts/prepare-content.mjs \
    && node node_modules/@docusaurus/core/bin/docusaurus.mjs build --out-dir /tmp/site \
    && rm -rf /tmp/site /app/generated/*

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -q -O - http://127.0.0.1/healthz || exit 1
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
