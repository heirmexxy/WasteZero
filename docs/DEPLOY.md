# Deploying WasteZero to wastezero.tech

## Quickest: a server that runs Dokploy (one line)

1. Point the domain at the server: two **A** records (`@` and `www`) in hPanel, both set to the server's IP.
2. Open the server's terminal (for example, Hostinger's browser terminal) and paste this line:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/heirmexxy/wastezero/main/deploy/install.sh | bash
   ```

The script does everything below on its own, with no Docker image and no Dokploy dashboard:
- installs a private copy of Node.js, so other apps keep their own;
- downloads the code and runs the tests;
- creates the settings file with a new admin key (saved in `/root/wastezero-admin-key.txt`);
- starts WasteZero as a service;
- adds a route file so Dokploy's Traefik serves https://wastezero.tech with its own certificate.

Running the same line again updates WasteZero and keeps your settings and data.

The manual steps below are for servers without Dokploy.

---

These steps put WasteZero on one of your Hostinger VPS servers, with HTTPS and no Docker. Do them in order. Each step ends with a check, so you know it worked before moving on.

Pick the server with the most free memory (one of the KVM 2 machines is a good choice). Commands run over SSH as root unless the step says otherwise.

---

### Step 1: Point the domain at the server
In Hostinger hPanel → Domains → wastezero.tech → DNS, add two **A records**: `@` and `www`. Both point to the server's IP address.

**Check:** a few minutes later, `ping wastezero.tech` from your computer shows that IP.

### Step 2: Install Node.js 22
```bash
node --version
```
If it prints `v20.6` or newer, skip to step 3. Otherwise:
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git
```
**Check:** `node --version` prints `v22…`.

### Step 3: Create an app user and download the code
```bash
useradd --system --create-home --home-dir /opt/wastezero --shell /usr/sbin/nologin wastezero
sudo -u wastezero git clone https://github.com/heirmexxy/WasteZero.git /opt/wastezero
cd /opt/wastezero && sudo -u wastezero npm test
```
If the repo is private, create a read-only deploy key on GitHub, or clone over HTTPS with a token.

**Check:** the last lines say `# fail 0`.

### Step 4: Create the settings file
```bash
cd /opt/wastezero
sudo -u wastezero cp .env.example .env
sudo -u wastezero mkdir -p data
nano .env
```
Set at least these:
```
WASTEZERO_ADMIN_KEY=<run: openssl rand -hex 32>
OPENAI_API_KEY=<WasteZero's own OpenAI key>
ANTHROPIC_API_KEY=<optional: WasteZero's own Anthropic key, for quality tests on Claude traffic>
PUBLIC_BASE_URL=https://wastezero.tech
TRUST_PROXY=true
```
Leave `PAYMENT_PROVIDER=none` and `EMAIL_PROVIDER=log` for now; you'll turn them on in step 9.

Then lock the file down:
```bash
chmod 600 .env && chown wastezero:wastezero .env
```
**Check:** `sudo -u wastezero node --env-file=.env -e "console.log('ok')"` prints `ok`.

### Step 5: Run it as a service
```bash
cp /opt/wastezero/deploy/wastezero.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now wastezero
```
**Check:** `curl http://127.0.0.1:8787/health` prints `{"ok":true,...}`. If it doesn't, see why with `journalctl -u wastezero -n 50`.

### Step 6: Find out which web server is already running
Your servers already host other platforms, so ports 80 and 443 may be taken.
```bash
ss -ltnp | grep -E ':(80|443) '
```
- **Shows `nginx`:** go to step 7A.
- **Shows nothing:** go to step 7B.
- **Shows something else** (Apache, Caddy): tell me what it says and I'll give you the matching config.

### Step 7A: HTTPS with your existing nginx
```bash
cp /opt/wastezero/deploy/nginx.conf /etc/nginx/sites-available/wastezero.tech
ln -s /etc/nginx/sites-available/wastezero.tech /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d wastezero.tech -d www.wastezero.tech
```
**Check:** https://wastezero.tech shows the landing page with a padlock.

### Step 7B: HTTPS with Caddy (nothing on ports 80/443)
```bash
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
cp /opt/wastezero/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
```
**Check:** https://wastezero.tech shows the landing page with a padlock.

### Step 8: Create your first customer and send a test request
```bash
ADMIN=$(grep ^WASTEZERO_ADMIN_KEY /opt/wastezero/.env | cut -d= -f2)
curl -s -X POST https://wastezero.tech/admin/tenants -H "Authorization: Bearer $ADMIN" \
  -H "content-type: application/json" -d '{"name":"Test customer","email":"you@example.com"}'
```
Copy the `apiKey` from the reply, then send a request through it:
```bash
curl -s https://wastezero.tech/v1/chat/completions -H "Authorization: Bearer wz_..." \
  -H "content-type: application/json" -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Say hi"}]}'
```
**Check:** you get an answer, and `curl -s https://wastezero.tech/admin/summary -H "Authorization: Bearer $ADMIN"` shows 1 call with a cost.

### Step 9: Turn on email and payments (test mode first)
1. **Email:** in `.env`, set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM` (a sending address on a domain you've verified with Resend), `SENDER_NAME` and `SENDER_ADDRESS`.
2. **Payments:** pick Paystack or Stripe.
   - **Paystack:** set `PAYMENT_PROVIDER=paystack` and `PAYSTACK_SECRET_KEY=sk_test_…`. No webhook is needed: WasteZero checks with Paystack directly when a customer returns from saving a card. **Leave your Paystack webhook pointing at the Abia ADDS platform.** That platform will now also receive WasteZero's card-setup and invoice events, so make sure it ignores events it doesn't recognise.
   - **Stripe:** set `PAYMENT_PROVIDER=stripe`, `STRIPE_SECRET_KEY=sk_test_…`, and `STRIPE_WEBHOOK_SECRET`. Point the Stripe webhook at `https://wastezero.tech/webhooks/payments`.
3. Apply the changes: `systemctl restart wastezero`.

**Check:** create a card link with `POST /admin/tenants/<id>/card-link`, save a test card, and confirm `GET /admin/tenants` shows `"hasCard": true`.

### Step 10: Turn on the operator
In `.env`, set `OPERATOR_INTERVAL_MS=3600000` (hourly), and set `ESCALATION_WEBHOOK_URL` to a Slack incoming webhook if you use Slack. Then run `systemctl restart wastezero`.

**Check:** `curl -s -X POST https://wastezero.tech/admin/operator/run -H "Authorization: Bearer $ADMIN"` returns a report with `"halted": false`.

---

## Updating later
```bash
sudo bash /opt/wastezero/deploy/update.sh
```
This runs the installer again: it pulls the latest code, runs the tests, restarts WasteZero, and keeps your settings and data.

## Backups
Everything lives in `/opt/wastezero/data`. Back it up daily, for example:
```bash
tar czf /root/wastezero-$(date +%F).tgz -C /opt/wastezero data
```
Keep the copies off the server.

## Updating to 0.7.0
Re-run the installer (it keeps your .env and data):

    curl -fsSL https://raw.githubusercontent.com/heirmexxy/wastezero/main/deploy/install.sh | bash

Then set `FOUNDER_EMAIL`, an AI key (e.g. `OPENAI_API_KEY`) and optionally `TELEGRAM_BOT_TOKEN` / `TELEGRAM_BOT_USERNAME` in `/opt/wastezero/.env`, and run `systemctl restart wastezero`.
