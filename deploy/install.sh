#!/usr/bin/env bash
# One-command install / update of WasteZero on a server that runs Dokploy (Traefik).
#
#   curl -fsSL https://raw.githubusercontent.com/heirmexxy/wastezero/main/deploy/install.sh | bash
#
# Safe to run again: it updates the code, keeps your settings and data, and restarts.
# It does not touch other apps: WasteZero gets its own Node.js in /opt/wastezero-node,
# its own user, its own service, and one extra Traefik route file.
set -euo pipefail

DOMAIN="${DOMAIN:-wastezero.tech}"
REPO="${REPO:-https://github.com/heirmexxy/wastezero.git}"
APP=/opt/wastezero
NODE_DIR=/opt/wastezero-node
PORT=8787
TRAEFIK_DIR=/etc/dokploy/traefik/dynamic

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m    ! %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mSTOPPED: %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = 0 ] || fail "Run this as root."

say "1/8 Checking the domain points here"
MY_IPS="$(hostname -I 2>/dev/null || true)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')"
if [ -z "$DNS_IP" ]; then warn "$DOMAIN does not resolve yet. HTTPS will start working once DNS points here."
elif echo " $MY_IPS " | grep -q " $DNS_IP "; then echo "    $DOMAIN -> $DNS_IP (this server)"
else warn "$DOMAIN points to $DNS_IP, not this server ($MY_IPS). Fix the A record in hPanel; continuing anyway."; fi

say "2/8 Tools (git)"
command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git; }
command -v xz >/dev/null || apt-get install -y -qq xz-utils
echo "    ok"

say "3/8 Node.js 22 just for WasteZero (other apps keep their own Node)"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  case "$(uname -m)" in x86_64) ARCH=x64;; aarch64|arm64) ARCH=arm64;; *) fail "Unsupported CPU $(uname -m)";; esac
  BASE=https://nodejs.org/dist/latest-v22.x
  SUMS="$(curl -fsSL "$BASE/SHASUMS256.txt")"
  FILE="$(echo "$SUMS" | awk -v a="linux-$ARCH.tar.xz" '$2 ~ a"$" {print $2; exit}')"
  [ -n "$FILE" ] || fail "Could not find the Node.js download"
  curl -fsSL "$BASE/$FILE" -o "/tmp/$FILE"
  (cd /tmp && echo "$SUMS" | grep " $FILE\$" | sha256sum -c --quiet) || fail "Node.js download failed its checksum"
  mkdir -p "$NODE_DIR" && tar -xJf "/tmp/$FILE" -C "$NODE_DIR" --strip-components=1 && rm -f "/tmp/$FILE"
fi
NODE="$NODE_DIR/bin/node"
echo "    $("$NODE" --version) at $NODE"

say "4/8 App user and code"
id wastezero >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin wastezero
if [ -d "$APP/.git" ]; then
  git -C "$APP" config --global --add safe.directory "$APP" 2>/dev/null || true
  git -C "$APP" fetch -q origin main && git -C "$APP" reset -q --hard origin/main
  echo "    updated to $(git -C "$APP" log --oneline -1)"
else
  git clone -q "$REPO" "$APP"
  echo "    downloaded $(git -C "$APP" log --oneline -1)"
fi
mkdir -p "$APP/data"

say "5/8 Running the tests (about 30 seconds)"
(cd "$APP" && "$NODE" --test test/*.test.js > /tmp/wastezero-tests.log 2>&1) \
  || { tail -30 /tmp/wastezero-tests.log; fail "Tests failed; nothing was changed in the running service."; }
grep -E "^# (pass|fail)" /tmp/wastezero-tests.log | tr '\n' ' '; echo

say "6/8 Settings"
# Traefik runs inside Docker; it reaches WasteZero on the Docker bridge address of this server.
BIND_IP="$(ip -4 -o addr show docker0 2>/dev/null | awk '{print $4}' | cut -d/ -f1)"
[ -n "$BIND_IP" ] || fail "No docker0 network found. Is Dokploy/Docker running on this server?"
ENV="$APP/.env"
if [ ! -f "$ENV" ]; then
  cp "$APP/.env.example" "$ENV"
  ADMIN_KEY="$(openssl rand -hex 32)"
  sed -i \
    -e "s|^WASTEZERO_ADMIN_KEY=.*|WASTEZERO_ADMIN_KEY=$ADMIN_KEY|" \
    -e "s|^OPENAI_API_KEY=.*|OPENAI_API_KEY=|" \
    -e "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://$DOMAIN|" \
    -e "s|^TRUST_PROXY=.*|TRUST_PROXY=true|" \
    -e "s|^DATA_DIR=.*|DATA_DIR=$APP/data|" "$ENV"
  echo "$ADMIN_KEY" > /root/wastezero-admin-key.txt && chmod 600 /root/wastezero-admin-key.txt
  echo "    created $ENV (new admin key saved to /root/wastezero-admin-key.txt)"
else
  echo "    kept your existing $ENV"
fi
sed -i -e "s|^HOST=.*|HOST=$BIND_IP|" -e "s|^PORT=.*|PORT=$PORT|" "$ENV"
chmod 600 "$ENV"
chown -R wastezero:wastezero "$APP"

# If the server firewall is on, let Docker containers (Traefik) reach WasteZero's port.
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow from 172.16.0.0/12 to any port "$PORT" proto tcp >/dev/null && echo "    firewall: allowed Docker → port $PORT"
fi

say "7/8 Service"
cat > /etc/systemd/system/wastezero.service <<UNIT
[Unit]
Description=WasteZero
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=wastezero
Group=wastezero
WorkingDirectory=$APP
ExecStart=$NODE --env-file=$ENV src/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$APP/data

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable -q wastezero
systemctl restart wastezero
for i in $(seq 1 20); do
  curl -fsS "http://$BIND_IP:$PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://$BIND_IP:$PORT/health" >/dev/null 2>&1 \
  || { journalctl -u wastezero -n 30 --no-pager; fail "WasteZero did not start; the log is above."; }
echo "    running on http://$BIND_IP:$PORT"

say "8/8 HTTPS route in Traefik"
[ -d "$TRAEFIK_DIR" ] || fail "$TRAEFIK_DIR not found. Is this a Dokploy server?"
RESOLVER="$(grep -rhoE 'certResolver:\s*[A-Za-z0-9_-]+' "$TRAEFIK_DIR" 2>/dev/null | head -1 | awk '{print $2}')"
RESOLVER="${RESOLVER:-letsencrypt}"
cat > "$TRAEFIK_DIR/wastezero.yml" <<YAML
# WasteZero: written by deploy/install.sh
http:
  routers:
    wastezero-https:
      rule: "Host(\`$DOMAIN\`) || Host(\`www.$DOMAIN\`)"
      entryPoints: [websecure]
      service: wastezero
      tls:
        certResolver: $RESOLVER
    wastezero-http:
      rule: "Host(\`$DOMAIN\`) || Host(\`www.$DOMAIN\`)"
      entryPoints: [web]
      service: wastezero
      middlewares: [wastezero-to-https]
  middlewares:
    wastezero-to-https:
      redirectScheme:
        scheme: https
        permanent: true
  services:
    wastezero:
      loadBalancer:
        passHostHeader: true
        servers:
          - url: "http://$BIND_IP:$PORT"
YAML
echo "    route written (certificate issuer: $RESOLVER); waiting for HTTPS..."
OK=""
for i in $(seq 1 40); do
  if curl -fsS --max-time 5 "https://$DOMAIN/health" >/dev/null 2>&1; then OK=1; break; fi
  sleep 3
done

printf '\n\033[1;32m================ WasteZero is installed ================\033[0m\n'
if [ -n "$OK" ]; then echo "  Live at:      https://$DOMAIN"
else echo "  Running, but https://$DOMAIN is not answering yet (DNS or certificate still settling)."
     echo "  Check again in a few minutes:  curl https://$DOMAIN/health"; fi
echo "  Admin key:    cat /root/wastezero-admin-key.txt"
echo "  Settings:     nano $ENV   then   systemctl restart wastezero"
echo "  Logs:         journalctl -u wastezero -f"
echo "  Update later: run the same install line again"
