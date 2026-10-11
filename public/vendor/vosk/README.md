# Vendored speech recognizer (vosk-browser 0.0.8), unmodified

The brake's own ear. On Cassie's phone the browser's speech recognizer and a
recording can't hold the microphone at the same time (the brake drill proved
it, Oct 11), so while a voice note or a "let him hear you" recording runs, the
brake listens through the recording's own audio instead, with this offline
recognizer (Vosk, compiled to WebAssembly; the worker and wasm are embedded in
vosk.js). Nothing it hears leaves the phone.

Copied verbatim from the npm package `vosk-browser@0.0.8` (`dist/vosk.js`).
Self-hosted for the same reason as the device engine: a safety feature
shouldn't depend on a CDN being reachable that night.

The English model (vosk-model-small-en-us-0.15, ~41 MB) is fetched once from
the vosk-browser project's published models and then kept in the phone's
IndexedDB by the recognizer itself.
