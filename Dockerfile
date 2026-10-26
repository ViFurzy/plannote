FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DB=/data/boardsync.db BACKUP_DIR=/data/backups

# production dependencies only; Node 24 runs the TypeScript directly, so there is no build step
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.ts unfurl.ts index.html login.html portable.js icons.js shapes.js templates.js account.js ./
COPY public ./public

# the database and its backups live in the /data volume, so the image can be replaced without losing boards
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.ts"]
