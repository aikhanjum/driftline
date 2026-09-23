#!/bin/sh
set -eu

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  printf 'The pinned demo generator currently supports Apple Silicon macOS.\n' >&2
  exit 1
fi

driftline_root=$(cd "$(dirname "$0")/.." && pwd)
driftline_runtime_dir="$driftline_root/.cache/llama"
driftline_version=b11149
driftline_runtime_sha=791eb0200a7c846ca925b6274fc21f0f21f537fda2924cc5a47402655816f56e
driftline_model_sha=9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031
driftline_partial=
driftline_stage=

cleanup() {
  if [ -n "$driftline_partial" ]; then rm -f "$driftline_partial"; fi
  if [ -n "$driftline_stage" ]; then rm -rf "$driftline_stage"; fi
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fetch_verified() {
  driftline_target=$1
  driftline_url=$2
  driftline_expected=$3
  if [ -f "$driftline_target" ]; then
    if ! printf '%s  %s\n' "$driftline_expected" "$driftline_target" | shasum -a 256 -c -; then
      printf 'Remove the file with the checksum mismatch and run setup again.\n' >&2
      exit 1
    fi
    return
  fi
  mkdir -p "$(dirname "$driftline_target")"
  driftline_partial=$(mktemp "$driftline_target.part.XXXXXX")
  curl -fL --retry 3 --connect-timeout 30 -o "$driftline_partial" "$driftline_url"
  printf '%s  %s\n' "$driftline_expected" "$driftline_partial" | shasum -a 256 -c -
  mv "$driftline_partial" "$driftline_target"
  driftline_partial=
}

fetch_verified "$driftline_runtime_dir/runtime.tar.gz" \
  "https://github.com/ggml-org/llama.cpp/releases/download/$driftline_version/llama-$driftline_version-bin-macos-arm64.tar.gz" \
  "$driftline_runtime_sha"
fetch_verified "$driftline_root/.cache/generator/qwen3-0.6b-q8.gguf" \
  'https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/23749fefcc72300e3a2ad315e1317431b06b590a/Qwen3-0.6B-Q8_0.gguf' \
  "$driftline_model_sha"

# Always compare an existing installation with the verified archive.
driftline_stage=$(mktemp -d "$driftline_runtime_dir/.extract.XXXXXX")
tar -xzf "$driftline_runtime_dir/runtime.tar.gz" -C "$driftline_stage"
driftline_install="$driftline_runtime_dir/llama-$driftline_version"
if [ -e "$driftline_install" ]; then
  if ! diff -qr "$driftline_stage/llama-$driftline_version" "$driftline_install" >/dev/null; then
    printf 'The installed generator differs from its verified archive.\nRemove %s and run setup again.\n' "$driftline_install" >&2
    exit 1
  fi
else
  mv "$driftline_stage/llama-$driftline_version" "$driftline_install"
fi
test -x "$driftline_install/llama-server"
printf 'Verified llama.cpp %s and Qwen3 0.6B Q8.\n' "$driftline_version"
