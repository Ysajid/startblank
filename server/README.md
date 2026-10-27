# startblank vault server

Stores every account's notes as plain Markdown files on disk — real file
names, real folders — so they can be read and edited by agents, scripts and
AI tools on the same machine, as well as by the app.

```
/mnt/vaults/vaults/<user id>/
├── Ideas/
│   └── On walking.md
├── বাংলা/
│   └── আমার নোট.md
└── .startblank/record/…      the hand-writing records (see src/lib/noteFile.ts)
```

- **Who can see what:** every request carries the user's Supabase access
  token, verified locally (against the project's signing keys). The server
  only ever touches that user's folder; paths that try to leave it, and
  symlinks, are refused.
- **Safe saves:** writes are atomic (written beside, then renamed) and
  conditional — the app sends the version it last saw, and the server
  refuses to overwrite a file that changed since. The app then keeps both
  versions.
- **Search index:** after every change — through the API *or* directly on
  disk — the server updates the search index in Supabase
  (`public.note_index`: words, title, links, a short excerpt; never the
  note text).

## Deploying on a DigitalOcean droplet

Ubuntu 24.04, the smallest droplet is plenty to start. You need a domain
name for HTTPS (browsers won't let an HTTPS app talk to a plain-HTTP API).

### 1. A volume for the notes

In the DigitalOcean panel, create a **Volume** (10 GB is a lot of text),
attach it to the droplet, and mount it at `/mnt/vaults` (pick "Manually
format & mount" and follow the commands it shows, using `/mnt/vaults` as
the mount point). The notes then live apart from the droplet: you can
resize, snapshot or move them to a new droplet independently. Turn on
**volume snapshots** (or droplet backups) — the files are your users' only
copy.

### 2. Supabase

Run, in order, in the Supabase SQL editor: `supabase/schema.sql`,
`supabase/accounts.sql`, `supabase/search.sql`. Note your project URL and
service-role key (Project Settings → API).

### 3. The server

```bash
# as root on the droplet
apt update && apt install -y git debian-keyring debian-archive-keyring apt-transport-https curl
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs

# a user for the service, owning the vault folder
adduser --system --group --home /opt/startblank startblank
mkdir -p /mnt/vaults/vaults
chown startblank:startblank /mnt/vaults/vaults
chmod 2770 /mnt/vaults/vaults           # group-writable, new folders inherit the group

# the code
git clone <your repo url> /opt/startblank/src   # private repo: add a deploy key first
ln -s /opt/startblank/src/server /opt/startblank/server
cd /opt/startblank/server && npm ci && npm run build
chown -R startblank:startblank /opt/startblank

# configuration
mkdir -p /etc/startblank
cp deploy/vault.env.example /etc/startblank/vault.env
nano /etc/startblank/vault.env           # fill in SUPABASE_URL, the key, ALLOWED_ORIGINS
chmod 600 /etc/startblank/vault.env

# run it
cp deploy/startblank-vault.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now startblank-vault
journalctl -u startblank-vault -f        # should say "listening on http://127.0.0.1:8787"
```

### 4. HTTPS with Caddy

Point a DNS **A record** (e.g. `vault.yourdomain.com`) at the droplet's IP,
then:

```bash
apt install -y caddy
cp /opt/startblank/server/deploy/Caddyfile /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile                # replace vault.example.com with your name
systemctl reload caddy

ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
curl https://vault.yourdomain.com/healthz    # {"ok":true}
```

### 5. Point the app at it

In the web app's `.env` (repo root):

```
VITE_VAULT_API_URL=https://vault.yourdomain.com
```

and make sure the app's origin is in `ALLOWED_ORIGINS`. Rebuild and
redeploy the app. (The Caddyfile has an optional block to serve the app
from the same droplet.)

## Agents on the droplet

Run agents as a user in the `startblank` group (`usermod -aG startblank
<user>`) and point them at `/mnt/vaults/vaults/<user id>/`. Anything they
write is indexed within a second and shows up in the app on its next sync,
with their text marked as not written by hand.

## Day to day

- **Update:** `cd /opt/startblank/src && git pull && cd server && npm ci && npm run build && systemctl restart startblank-vault`
- **Rebuild every search index** (e.g. after restoring a backup):
  `systemd-run --uid=startblank -p EnvironmentFile=/etc/startblank/vault.env --working-directory=/opt/startblank/server --pty node dist/index.js reindex-all`
- **Logs:** `journalctl -u startblank-vault`

## API

All routes need `Authorization: Bearer <Supabase access token>` and act on
that user's folder; paths are vault-relative.

| Route | |
|---|---|
| `GET /v1/files` | every file with its etag |
| `GET /v1/file?path=…` | a file's text (`ETag` header) |
| `HEAD /v1/file?path=…` | its `ETag`, or 404 |
| `PUT /v1/file?path=…` | write; `If-Match: "<etag>"` / `If-None-Match: *` make it conditional (412 if not met) |
| `POST /v1/move` `{from, to}` | 409 if `to` exists |
| `POST /v1/delete` `{paths}` | |
| `POST /v1/reindex` | rebuild this user's search index |
| `GET /healthz` | no auth |
