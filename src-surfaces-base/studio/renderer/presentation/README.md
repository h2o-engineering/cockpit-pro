# Renderer presentation — PresentationProfile registry contract

Module: `presentation-profile.v1.js` (`H2O.Studio.Renderer.presentationProfile`,
schema `h2o.renderer.presentation-profile` v1, API `1.0.0-m04-p1`).
Reference stylesheet: `chatgpt-reference.v1.css` (linked by studio.html after
studio.css; this module loads no stylesheet).

## What a profile decides

A PresentationProfile names the presentation / compatibility class hooks layered
onto the Renderer's H2O-owned structure. It never decides which nodes exist,
their role, identity, accessibility or security policy, never reads or changes
Render IR, never touches the DOM and persists nothing. Semantic content is
identical under every profile by construction.

Renderer-owned vocabulary is rejected in hooks: `cgFrame cgBody cgThread cgScroll
cgTurn cgTurn--* cgMsg cgMsgBody cgBubble cgBubble--* cgBubbleRail
cgUserAttachment* cgTurn--has-attachments wbReaderScroll wbRichRoot`.
`cgMsg--<modifier>` stays admissible (message presentation modifiers).

Since M04 P1 T1 the Renderer itself emits `wbRichRoot` on the transcript root in
both modes (compatibility root the global stylesheet keys on) and owns provider
bubble capture recognition (`RICH_REPLAY_SOURCE_COMPAT` in
`chat-renderer.studio.js`); neither is a profile hook.

## Definition

`define(definition)` validates and returns a frozen, admitted profile (not yet
registered). Fields, all required:

| Field | Rule |
| --- | --- |
| `id` | lowercase kebab-case identifier, unique in the registry |
| `owner` | non-blank string (Lane / contributor) |
| `version` | semver |
| `displayName` | non-blank string |
| `provider` | non-blank string or `null` |
| `stylesheet` | `null` or `{ href, version? }`; relative href, no scheme / root / traversal / query — admission metadata only |
| `modes` | exactly `["canonical", "rich"]` |
| `hooks` | `transcript[mode]`, `turn.base / turn[mode] / turn.role[role]`, `message[mode][role]`, `userBubble.compat`, `content[kind][slot]`, `state.edited.turn / .message` — every leaf a frozen array of valid, unrepeated class tokens |

Profile helpers: `transcriptClasses(mode)`, `turnClasses(role, mode)`,
`messageClasses(role, mode)`, `userBubbleClasses()`, `contentClasses(kind, slot)`
(frozen `[]` when undeclared), `codeBlockClasses()` / `codeLanguageClasses()`
(compatibility wrappers over `contentClasses("codeBlock", …)`),
`editedTurnClasses()`, `editedMessageClasses()`. Unknown roles / modes throw.

## Registry lifetime

| API | Behaviour |
| --- | --- |
| `register(profileOrDefinition)` | append-only; validates plain definitions through `define()`; duplicate id → `TypeError` (`code: "duplicate-id"`); after sealing → `Error` (`code: "registry-sealed"`) |
| `get(id)` / `ids()` / `list()` | registered profile or `null`; frozen ids / profiles in registration order |
| `reference()` / `default()` | the built-in `chatgpt-reference` profile (`referenceId`); not mutable |
| `resolve(requestedId)` | frozen `{ requestedId, effectiveId, profile, reason }` with reason `explicit`, `default` (absent / empty request) or `unknown-profile-fallback`; never throws |
| `seal()` / `sealed()` / `registryDigest()` | idempotent; the digest is the deterministic evidence token (JSON of the sorted `{ id, owner, version }` entries), `null` before sealing |

The reference profile is defined and registered at install through the same
public path. Registration stays open after installation; the Renderer seals the
registry at its first render in the document (M04 P1 T2 wiring). There is no
dispose, unregister, replacement, re-registration or hot reload; every admitted
definition and its metadata are immutable for the document lifetime. Test
isolation uses fresh contexts, not production lifecycle machinery.

The evidence token is not a security digest and not a cross-document cache
guarantee.

## ContentRenderer counterpart

`content-renderer.v1.js` (API `2.0.0`) applies the same lifetime rules to
content renderers: `register(kind, fn, meta)` returns the kind string, accepts
only admitted Render IR kinds (core + reserved extension kinds), requires
non-blank `meta.owner` and semver `meta.version` for extensions, rejects
duplicates and post-seal registration (`registry-sealed`), and exposes
`describe(kind)` / `describe()`, `seal()`, `sealed()`, `registryDigest()`. Core
renderers install once with Renderer-owned metadata and cannot be overridden.
