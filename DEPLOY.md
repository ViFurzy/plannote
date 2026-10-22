# Running boardsync in production

## Docker / Portainer
1. Push this repo to GitHub/GitLab (private is fine).
2. Portainer > Stacks > Add stack > **Repository**: repository URL, reference `refs/heads/main`, compose path `docker-compose.yml`
   (add credentials if the repo is private). Optional environment variables: `PORT` (published port, default 3000), `ORIGINS`, `HTTPS`.
3. Deploy. Boards live in the `boardsync-data` volume (database plus a backup every 6 hours, newest 7); updating the stack keeps them.
4. For HTTPS, put a reverse proxy in front that forwards WebSockets **and keeps the Host header** (nginx: `proxy_set_header Host $host;`
   `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection upgrade;`), then set `HTTPS=1`. If the proxy rewrites Host, list the
   public address in `ORIGINS`.

**Testers and identity:** there is no login yet, so a tester's identity is just a name in their browser and anyone who can reach the port can
claim any name (and open any board whose id they know). Keep it on a private network/VPN or behind your proxy's basic auth while testing.

## Without Docker
Node 24+. `npm ci --omit=dev && npm start` (tsx runs the TypeScript directly).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | listen port |
| `HOST` | all interfaces | set `127.0.0.1` when a reverse proxy runs on the same machine |
| `DB` | `boardsync.db` | SQLite file (WAL mode; keep it on a persistent disk) |
| `BACKUP_DIR` | off | a consistent copy of the database at start and every 6 hours, newest 7 kept |
| `ORIGINS` | none | extra allowed WebSocket origins, comma separated (this server's own origin is always allowed) |
| `HTTPS` | off | `1` adds the HSTS header (it is also added when the proxy sends `X-Forwarded-Proto: https`) |

## TLS
Put Caddy/nginx in front for HTTPS and forward WebSockets. Caddy: `example.com { reverse_proxy 127.0.0.1:3000 }`.
`GET /healthz` answers `ok` for load balancer checks. SIGTERM/SIGINT close the database cleanly.

## What is protected
Security headers (CSP, nosniff, no framing, no referrer) on every response; WebSocket Origin check; element size cap (200 KB);
per-connection flood limit; 30 uploads/min/user; 5 MB image cap with real-byte check; unused uploads deleted after a day;
link previews can't reach private addresses.

## Not done yet
- **No real login.** The user id is whatever the client claims (`?u=name`), so anyone who can reach the server can act as anyone.
  Don't expose it to the open internet until login is added, or put it behind your proxy's own authentication.
- Trash is never emptied (restore works forever); the whole board set is held in memory.
