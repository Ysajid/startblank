# startblank vault server

Stores every account's notes in Postgres and serves them to the app: one
row per note (Markdown text + its hand-writing record, saved together),
folders, revision history tagged by author, and full-text search and
backlinks in the same database.

- **Privacy is enforced by the database.** The server connects as
  `startblank_app`, a role that owns nothing and is subject to row-level
  security. Every request runs in a transaction pinned to the signed-in user
  (from their verified Supabase token), and the policies make every other
  user's rows invisible — even to a query with a bug in it.
- **Nothing is silently overwritten.** Each save names the version it
  started from; if the note changed since (another device, an agent), the
  save is refused and the app keeps both versions.
- **Sign-in stays with Supabase.** Tokens are verified locally against the
  project's public keys; this server holds no Supabase secret.

## Deploying on a DigitalOcean droplet

Ubuntu 24.04; a 2 GB droplet is comfortable for Postgres plus the server.
You need a domain name for HTTPS.

### 1. Droplet, volume, DNS

1. **Create → Droplet**: Ubuntu 24.04, 2 GB, add your SSH key.
2. **Create → Volume**: 10 GB, attached to the droplet, **"Manually format &
   mount"**, named `data`. The database lives here, apart from the droplet.
3. **DNS**: an **A record** `vault.yourdomain.com` → the droplet's IP.

```bash
ssh root@YOUR_DROPLET_IP

mkfs.ext4 /dev/disk/by-id/scsi-0DO_Volume_data
mkdir -p /mnt/data
echo '/dev/disk/by-id/scsi-0DO_Volume_data /mnt/data ext4 defaults,nofail,discard,noatime 0 2' >> /etc/fstab
mount -a && df -h /mnt/data
```

### 2. Postgres, on the volume

```bash
apt update && apt install -y postgresql-16 git curl caddy

# Put the database cluster on the volume instead of the droplet's disk.
pg_dropcluster 16 main --stop
mkdir -p /mnt/data/postgresql /mnt/data/backups
chown postgres:postgres /mnt/data/postgresql /mnt/data/backups
pg_createcluster -d /mnt/data/postgresql/16/main 16 main --start

# Don't start Postgres before the volume is mounted.
mkdir -p /etc/systemd/system/postgresql@16-main.service.d
printf '[Unit]\nRequiresMountsFor=/mnt/data\n' > /etc/systemd/system/postgresql@16-main.service.d/volume.conf
systemctl daemon-reload

# Two roles: an owner that runs migrations, and the restricted app role.
OWNER_PW=$(openssl rand -hex 24); APP_PW=$(openssl rand -hex 24)
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
create role startblank_owner login password '$OWNER_PW';
create role startblank_app login password '$APP_PW';
create database startblank owner startblank_owner;
SQL
echo "owner: $OWNER_PW"; echo "app:   $APP_PW"    # keep these somewhere safe
```

Postgres only listens on localhost by default — leave it that way; nothing
outside the droplet should reach port 5432.

### 3. The server

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs

adduser --system --group --home /opt/startblank startblank
git clone -b claude/handwritten-notes-app-zge469 https://github.com/Ysajid/startblank.git /opt/startblank/src
ln -s /opt/startblank/src/server /opt/startblank/server
cd /opt/startblank/server && npm ci && npm run build
chown -R startblank:startblank /opt/startblank

# Create the tables (as the owner role).
DATABASE_URL="postgres://startblank_owner:$OWNER_PW@127.0.0.1:5432/startblank" npm run migrate

# Configure: paste the app password into DATABASE_URL, set SUPABASE_URL
# and ALLOWED_ORIGINS.
mkdir -p /etc/startblank
cp deploy/vault.env.example /etc/startblank/vault.env
chmod 600 /etc/startblank/vault.env
nano /etc/startblank/vault.env

cp deploy/startblank-vault.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now startblank-vault
journalctl -u startblank-vault -n 20     # "listening on http://127.0.0.1:8787"
```

### 4. HTTPS and firewall

```bash
cp /opt/startblank/server/deploy/Caddyfile /etc/caddy/Caddyfile
sed -i 's/vault.example.com/vault.yourdomain.com/' /etc/caddy/Caddyfile
systemctl reload caddy

ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
curl https://vault.yourdomain.com/healthz        # {"ok":true}
```

### 5. Backups

```bash
echo '17 3 * * * postgres /opt/startblank/server/deploy/backup.sh' > /etc/cron.d/startblank-backup
```

That keeps 14 nightly dumps in `/mnt/data/backups`. Also turn on **volume
snapshots** in the DigitalOcean panel, and copy dumps off the droplet (e.g.
to Spaces) — the database is the only copy of everyone's notes. Restore a
dump with `pg_restore --clean -d startblank <file>` as the postgres user.

### 6. Supabase and the app

- In the Supabase SQL editor run `supabase/schema.sql`, then
  `supabase/accounts.sql` (sign-in and published share links).
- In the app's `.env`: `VITE_VAULT_API_URL=https://vault.yourdomain.com`,
  rebuild and redeploy. Its address must be in `ALLOWED_ORIGINS`.

## Updating

```bash
cd /opt/startblank/src && git pull
cd ../server && npm ci && npm run build
DATABASE_URL="postgres://startblank_owner:OWNER_PW@127.0.0.1:5432/startblank" npm run migrate
chown -R startblank:startblank /opt/startblank
systemctl restart startblank-vault
```

## API

All routes need `Authorization: Bearer <Supabase access token>` and act on
that user's vault only; paths are vault-relative (`Ideas/On walking.md`).

| Route | |
|---|---|
| `GET /v1/vault` | `{notes: [{path, version}], folders}` |
| `GET /v1/note?path=…` | `{body, record, version, updatedBy}` |
| `PUT /v1/note?path=…` | `{body, record, baseVersion}` → `{version}`; `baseVersion: null` creates; 412 if not current |
| `POST /v1/notes/move` | `{from, to}`; 409 if `to` exists |
| `POST /v1/notes/delete` | `{paths}` |
| `POST /v1/folders` | `{path}` |
| `POST /v1/folders/move` | `{from, to}` — the folder and everything in it, in one step |
| `POST /v1/folders/delete` | `{path}` |
| `GET /v1/search?q=…` | `[{path, title, excerpt}]` — all words, last as prefix; any language |
| `GET /v1/backlinks?path=…` | notes that `[[link]]` to it |
| `GET /v1/history?path=…` | revisions, newest first, with author (`app` or `agent:<name>`) |
| `GET /healthz` | no auth |
