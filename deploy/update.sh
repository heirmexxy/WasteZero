#!/usr/bin/env bash
# Update WasteZero to the latest code on GitHub: same as running the installer again.
# Keeps settings (.env) and data. Run as root.
set -euo pipefail
exec bash /opt/wastezero/deploy/install.sh
