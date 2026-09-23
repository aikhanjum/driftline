#!/bin/sh
set -eu

revision=2a4f614a701367a02d51389039afc998faeda637
model_dir=".cache/Xenova/nli-deberta-v3-xsmall/$revision"
base="https://huggingface.co/Xenova/nli-deberta-v3-xsmall/resolve/$revision"

fetch() {
  target="$model_dir/$1"
  expected="$2"
  if [ -s "$target" ]; then
    if printf '%s  %s\n' "$expected" "$target" | shasum -a 256 -c - >/dev/null; then
      printf 'Using %s\n' "$target"
      return
    fi
    printf 'Checksum mismatch for %s\n' "$target" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$target")"
  curl -fL --retry 3 -o "$target.tmp" "$base/$1"
  printf '%s  %s\n' "$expected" "$target.tmp" | shasum -a 256 -c -
  mv "$target.tmp" "$target"
  printf 'Fetched %s\n' "$target"
}

fetch onnx/model_int8.onnx e1878da6c3a689d7e7beb9703395880016c3585cd127f875be0acad02405737b
fetch spm.model c679fbf93643d19aab7ee10c0b99e460bdbc02fedf34b92b05af343b4af586fd
