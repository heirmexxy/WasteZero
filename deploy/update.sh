#!/usr/bin/env bash
# Pull the latest code from GitHub, run the tests, and restart. Run on the server as root:
#   sudo bash /opt/wastezero/deploy/update.sh
set -euo pipefail
cd /opt/wastezero
sudo -u wastezero git pull --ff-only
sudo -u wastezero npm test
systemctl restart wastezero
sleep 2
curl -fsS http://127.0.0.1:8787/health && echo " WasteZero restarted"
