#!/bin/sh
set -eu

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  printf 'Use an installed ONNX Runtime 1.21.0 C++ package on this platform.\n' >&2
  exit 1
fi

version=1.21.0
archive="onnxruntime-osx-arm64-$version.tgz"
root="build/deps/onnxruntime-osx-arm64-$version"
expected=5c3f2064ee97eb7774e87f396735c8eada7287734f1bb7847467ad30d4036115

if [ ! -f "$root/lib/libonnxruntime.$version.dylib" ]; then
  mkdir -p build/deps
  curl -fL --retry 3 -o "build/deps/$archive.tmp" \
    "https://github.com/microsoft/onnxruntime/releases/download/v$version/$archive"
  printf '%s  %s\n' "$expected" "build/deps/$archive.tmp" | shasum -a 256 -c -
  tar -xzf "build/deps/$archive.tmp" -C build/deps
  rm "build/deps/$archive.tmp"
fi

# The upstream archive's CMake target references include/onnxruntime, while its
# headers are placed directly in include. This local link repairs that target.
if [ ! -e "$root/include/onnxruntime" ]; then
  ln -s . "$root/include/onnxruntime"
fi
printf 'Using ONNX Runtime %s at %s\n' "$version" "$root"
