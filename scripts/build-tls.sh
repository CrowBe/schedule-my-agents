#!/usr/bin/env bash
set -euo pipefail
tls_go_bin=${1:?Supply the Go 1.27.1 executable path}
[[ "$("$tls_go_bin" version)" == 'go version go1.27.1 linux/amd64' ]] || { echo 'Use the pinned Go 1.27.1 Linux amd64 toolchain.' >&2; exit 1; }
cd "$(dirname "$0")/../tls-client"
GOOS=js GOARCH=wasm "$tls_go_bin" build -trimpath -ldflags='-s -w' -o tls.wasm .
cp "$("$tls_go_bin" env GOROOT)/lib/wasm/wasm_exec.js" wasm-exec.cjs
