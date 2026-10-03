# Vendored device engine (buttplug-wasm 3.0.0), with one edit

The upstream engine (buttplug-wasm-blob 3.0.0, May 2026) predates the
Lovense Fizz. When a Fizz connects, it reports Lovense model code "QB", the
engine has no entry for it, and the Rust core panics ("RuntimeError:
unreachable").

The engine's device table is JSON text inside the wasm binary. One entry the
house never uses, the Lovense Osci 3 ("OC"), which has two vibrate motors,
was retargeted in place to "QB" / "Fizz: suck+tap". Same byte length, so
nothing else in the binary moves. The Fizz becomes a two-motor Lovense: the
engine drives the heads with Lovense's per-motor commands (Vibrate1/Vibrate2),
and the house addresses them as vibrate1 / vibrate2 (aliases suction / tap).

Second edit (Oct 3): the engine's debug log showed the Fizz answers on none
of the Lovense Bluetooth services the engine knows, so it panicked
subscribing to a receive endpoint that wasn't there. Lovense services spell
the model code in hex (the Gravity "EA" is 45410001-...), so the Fizz "QB"
should be 51420001-0023-4bd4-bbd5-a6920e4c5653, with tx ...0002 and rx
...0003. The now-unused Osci 3 service (4f43...) was retargeted to it, in
all four places it appears. Same byte length.

- buttplug_wasm-fizz.js   the wasm module, base64 inside, patched as above
- buttplug-wasm-blob.mjs  upstream wrapper, import path pointed at the above
- buttplug-wasm.mjs       upstream connector, imports pointed here and at
                          eventemitter3@5.0.4 on esm.sh

When upstream ships a build that knows the Fizz, delete this folder and
import the official packages again (pinned).
