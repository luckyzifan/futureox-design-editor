#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
source /workspace/shared/design-phase2/rust-env.sh
cd "$root"
deps="$CARGO_TARGET_DIR/desktop-dev/deps"
serde=$(find "$deps" -name 'libserde_json-*.rlib' -print -quit)
base64=$(find "$deps" -name 'libbase64-*.rlib' -print -quit)
if [[ -z "$serde" || -z "$base64" ]]; then echo 'Missing cached production codec dependencies' >&2; exit 2; fi
rustc --edition 2024 -O --test design-studio/crates/design-gpu/src/serve_protocol.rs -L "dependency=$deps" --extern "serde_json=$serde" --extern "base64=$base64" -o testing/verification-native-render-transport/rust-codec-tests
rustc --edition 2024 -O testing/verification-native-render-transport/rust-codec-fixture.rs -L "dependency=$deps" --extern "serde_json=$serde" --extern "base64=$base64" -o testing/verification-native-render-transport/rust-codec-fixture
