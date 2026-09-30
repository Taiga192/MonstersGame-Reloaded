# MonstersGame-Reloaded server: Node + SQLite (a file on a volume) + the bots, serving the game and its API.
FROM node:24-slim

WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
# production dependencies only (hono + its node adapter); no build tools, no test tools
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts/admin.ts ./scripts/admin.ts

# The only writable place: the volume for the database and its backups. The process runs as the unprivileged "node" user.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/monsters.db \
    BACKUP_DIR=/data/backups
USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/catalog').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server.ts"]
