#!/bin/sh
# Nightly database backup: a compressed dump next to the database, keeping
# the last 14. Run from cron as the postgres user (see README). Copy these
# off the droplet too (e.g. to DigitalOcean Spaces) — a backup on the same
# machine doesn't survive losing the machine.
set -eu
DIR=/mnt/data/backups
mkdir -p "$DIR"
pg_dump --format=custom --file="$DIR/startblank-$(date +%Y%m%d-%H%M).dump" startblank
ls -1t "$DIR"/startblank-*.dump | tail -n +15 | xargs -r rm --
