#!/usr/bin/env bash
# Build a Connect IQ app for the FR965 and copy it to the watch over MTP.
# Usage: ./deploy.sh <app-dir>   e.g. ./deploy.sh rowing-recorder
set -euo pipefail
root=$(cd "$(dirname "$0")" && pwd)
app=${1:?usage: deploy.sh <app-dir>}
name=$(basename "$app" | tr -d '-' | tr '[:lower:]' '[:upper:]')
sdk=$(cat ~/.Garmin/ConnectIQ/current-sdk.cfg)

cd "$root/$app"
"$sdk/bin/monkeyc" -d fr965 -f monkey.jungle -o "bin/$name.prg" -y "$root/developer_key.der"

mtp=$(gio mount -l | grep -o 'mtp://091e_50db_[^/]*' | head -1 || true)
if [ -z "$mtp" ]; then
    echo "Watch not mounted over MTP; built bin/$name.prg only"
    exit 0
fi
apps="$mtp/Internal Storage/GARMIN/Apps"
gio remove "$apps/$name.PRG" 2>/dev/null || true
gio copy "bin/$name.prg" "$apps/$name.PRG"
# println output only lands in LOGS/<NAME>.TXT if that file already exists.
if ! gio info "$apps/LOGS/$name.TXT" >/dev/null 2>&1; then
    empty=$(mktemp)
    gio copy "$empty" "$apps/LOGS/$name.TXT"
    rm "$empty"
fi
echo "Deployed $name.PRG"
