#!/bin/sh
# Allow editing: MRH_EDIT=1 ./mrh-chatgpt-baslat.sh
cd "$(dirname "$0")"
exec node --disable-warning=ExperimentalWarning mrh/mrh-mcp.js --http --port "${MRH_PORT:-4791}"
