#!/usr/bin/bash
# Usage: pin-plugin-4.sh <new-digest> <new-backend-merge-commit> [plugin-repo]
# Re-pins Switchboard from backend v1.9.1-whkey.3 to v1.9.1-whkey.4: Model.js BACKEND_SHA256 + version comment, README digest/commit/tag mentions.
set -eu
unset -f grep 2>/dev/null; grep() { /usr/bin/grep "$@"; }
D="$1"; C="$2"; P="${3:-/home/leoom/Projects/switchboard}"
OLD_D=b2134dc1a9bc8ef899d7da63f880fc05268bc05ca0f1fe306f4a11bae35b61ad
OLD_C=34a9fd4df62231264ccbb97af116dbdf5edcc9cd
[[ "$D" =~ ^[0-9a-f]{64}$ ]] || { echo "bad digest"; exit 1; }
[[ "$C" =~ ^[0-9a-f]{40}$ ]] || { echo "bad commit"; exit 1; }
sed -i -E "s/(BACKEND_SHA256 = \")[0-9a-f]{64}(\")/\1$D\2/" "$P/Model.js"
sed -i -e "s/$OLD_D/$D/g" -e "s/${OLD_D:0:8}…[0-9a-f]*/${D:0:8}…${D:56}/g" -e "s/$OLD_C/$C/g" -e "s/${OLD_C:0:7}\b/${C:0:7}/g" -e "s/v1\.9\.1-whkey\.3\b/v1.9.1-whkey.4/g" "$P/README.md" "$P/Model.js"
echo "Model.js pin: $(grep -o 'BACKEND_SHA256 = "[0-9a-f]\{8\}' "$P/Model.js")"; echo "README mentions of new digest: $(grep -c "$D" "$P/README.md"), old digest left: $(grep -c "$OLD_D" "$P/README.md"), whkey.3 left: $(grep -c 'whkey\.3' "$P/README.md")"
cd "$P" && node --test model.test.mjs >/dev/null 2>&1 && echo "widget tests ok" || { echo "WIDGET TESTS FAILED"; exit 1; }; omarchy plugin validate . >/dev/null 2>&1 && echo "validate ok" || { echo "VALIDATE FAILED"; exit 1; }
