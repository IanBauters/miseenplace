#!/bin/sh
# Mise en Place — install or reinstall on a Synology NAS.
# Use: DSM → Control Panel → Task Scheduler → Create → Triggered Task → User-defined script,
#      user: root, event: Boot-up (or run it once by hand with "Run").
# Paste this whole file as the script. Data stays in $DATA between reinstalls and updates.
# Updates afterwards come from Watchtower; you don't need to run this again.

DATA=/volume1/docker/miseenplace     # where the database and daily backups live
PORT=8380                            # http://<nas-ip>:8380 on your home network
HTTPS_PORT=8443                      # https://<nas>.<tailnet>.ts.net:8443 via Tailscale (443, 8443 or 10000)
IMAGE=ghcr.io/ianbauters/miseenplace:latest
NAME=miseenplace

DOCKER=/usr/local/bin/docker
[ -x "$DOCKER" ] || DOCKER=$(command -v docker)
[ -n "$DOCKER" ] || { echo "Docker not found: install Container Manager first"; exit 1; }

mkdir -p "$DATA"
chown -R 1000:1000 "$DATA"   # the app runs as an unprivileged user (uid 1000) inside the container

echo "Pulling $IMAGE"
"$DOCKER" pull "$IMAGE" || { echo "Pull failed: is the GitHub package public? (see README)"; exit 1; }

if "$DOCKER" ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "Removing old container (data is kept)"
  "$DOCKER" rm -f "$NAME" >/dev/null
fi

"$DOCKER" run -d --name "$NAME" \
  --restart unless-stopped \
  -p "$PORT:8080" \
  -v "$DATA:/data" \
  -e TZ=Europe/Brussels \
  --label com.centurylinklabs.watchtower.enable=true \
  "$IMAGE" || exit 1

echo "Running on http://$(hostname -i 2>/dev/null | awk '{print $1}'):$PORT"

# HTTPS through Tailscale, needed for the camera (barcode scanning) and the offline cache on phones.
# Requires: Tailscale package on the NAS, and HTTPS certificates switched on in the Tailscale admin console (DNS page).
TS=/var/packages/Tailscale/target/bin/tailscale
[ -x "$TS" ] || TS=$(command -v tailscale)
if [ -n "$TS" ]; then
  sleep 5
  if "$TS" serve --bg --https="$HTTPS_PORT" "http://127.0.0.1:$PORT"; then
    echo "Tailscale HTTPS:"; "$TS" serve status
  else
    echo "Tailscale serve failed: check that HTTPS certificates are enabled for your tailnet"
  fi
else
  echo "Tailscale not found: the app works over http, but barcode scanning needs https"
fi
