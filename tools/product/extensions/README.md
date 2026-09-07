# tools/product/extensions/ — per-host/per-browser extension builders

Established in Phase 8G-2 (2026-05-19).

## Engineering Lane Boundary

This subtree contains build-time extension generators and packaging mechanics,
which remain Developer engineering responsibilities where applicable. The
generated Extension loader's admission, dependency/readiness ordering,
tiers/waves, scheduling, activation, and module-lifecycle semantics belong to
`L-RUNTIME-KERNEL-SCOPE-EXT`. Generator location does not transfer production
runtime semantics to Build tooling, and generated runtime behavior does not
make Runtime the owner of packaging mechanics.

Each subdirectory hosts the build pipeline for one extension product:

```
tools/product/extensions/
├── _shared/                ← cross-host/cross-browser build helpers (future)
├── chatgpt/firefox/        ← builder for chatgpt+firefox
├── claude/chrome/          ← builder for claude+chrome
├── claude/firefox/         ← builder for claude+firefox
├── gemini/chrome/          ← builder for gemini+chrome
└── gemini/firefox/         ← builder for gemini+firefox
```

**Note**: `chatgpt/chrome/` builders currently live at
`tools/product/extensions/chatgpt/chrome/` (singular, top-level), `tools/product/extensions/chatgpt/chrome/`,
and `tools/product/extensions/chatgpt/chrome/`. Their move into
`tools/product/extensions/chatgpt/chrome/` is a future phase (8G-4 in the
proposed roadmap) with byte-equivalence proof. Until then, this subtree
is empty for chatgpt+chrome.

## Per-host/per-browser builder shape

```
tools/product/extensions/<host>/<browser>/
├── build.mjs                  ← parameterized entry point (variant via env var)
├── manifest.mjs               ← per-host manifest customization
├── pack-<specialty>.mjs       ← single-variant specialty builders (optional)
└── README.md                  ← per-host build instructions
```

## What goes in `_shared/`

Cross-host/cross-browser build helpers. Today:

- **`build-extension-stub.mjs`** (Phase 8G-10) — `buildExtensionStub({ host, browser })` —
  the shared helper that all 5 stub builders (`claude/chrome`, `chatgpt/firefox`,
  `gemini/chrome`, `claude/firefox`, `gemini/firefox`) call. Reads source from
  `src/extensions/<host>/<browser>/`, identity from
  `config/extensions/<host>/<browser>/keys.json`, writes deterministic output
  to `apps/extensions/<host>/<browser>/<variant>/`. Handles both Chrome
  (`manifest.key` SPKI scheme) and Firefox (`browser_specific_settings.gecko`)
  identity schemes via a single browser switch.

Future additions when there's a real second consumer:

- `manifest-chrome.mjs` — extracted Chrome MV3 manifest template (currently inlined inside `build-extension-stub.mjs::composeManifest`)
- `manifest-firefox.mjs` — same for Firefox
- `icon-writer.mjs` — generic icon-pack-to-extension copier (the chatgpt+chrome legacy still uses its own `write-extension-icons.mjs`; promote when claude/gemini stubs add icons)
- `key-generator.mjs` — RSA-2048 key + Chrome ID generator (today generated ad-hoc per phase via inline `node -e`)
- `template/` — copy-template-from for new host/browser combos (today the 3-line wrapper at `tools/product/extensions/<host>/<browser>/build.mjs` IS the template — copy any of the 5 existing wrappers)

## Where to read more

- [../../../docs/architecture/MULTI_HOST_ARCHITECTURE.md](../../../docs/architecture/MULTI_HOST_ARCHITECTURE.md)
  — full architecture reference
- [../../../docs/architecture/PRODUCTS.md](../../../docs/architecture/PRODUCTS.md)
  — current product map
