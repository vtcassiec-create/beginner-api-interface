# Vendored device engine (buttplug-wasm 3.0.0), with one edit

The upstream engine (buttplug-wasm-blob 3.0.0, May 2026) predates the
Lovense Fizz. When a Fizz connects, it reports Lovense model code "QB", the
engine has no entry for it, and the Rust core panics ("RuntimeError:
unreachable").

The engine's device table is JSON text inside the wasm binary. One entry the
house never uses, the original Lovense Gush ("ED"), was retargeted in place
to "QB" / "Lovense Fizz". Same byte length, so nothing else in the binary
moves. It inherits the Lovense default: one vibrate motor (0-20) plus battery.

- buttplug_wasm-fizz.js   the wasm module, base64 inside, patched as above
- buttplug-wasm-blob.mjs  upstream wrapper, import path pointed at the above
- buttplug-wasm.mjs       upstream connector, imports pointed here and at
                          eventemitter3@5.0.4 on esm.sh

When upstream ships a build that knows the Fizz, delete this folder and
import the official packages again (pinned).
