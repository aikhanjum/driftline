#!/bin/sh
set -eu

driftline_root=$(cd "$(dirname "$0")/.." && pwd)
sh "$driftline_root/scripts/fetch-generator.sh"

# The browser talks through Driftline's local API. CORS is restricted to the
# local development page, and this model server accepts loopback traffic only.
exec "$driftline_root/.cache/llama/llama-b11149/llama-server" \
  --model "$driftline_root/.cache/generator/qwen3-0.6b-q8.gguf" \
  --alias driftline-demo \
  --host 127.0.0.1 \
  --port 11435 \
  --ctx-size 2048 \
  --n-gpu-layers 99 \
  --parallel 1 \
  --no-webui \
  --no-agent \
  --no-webui-mcp-proxy \
  --cors-origins 'http://127.0.0.1:5173,http://localhost:5173' \
  --no-cors-credentials \
  --reasoning off \
  --chat-template-kwargs '{"enable_thinking":false}'
