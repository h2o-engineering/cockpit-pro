# Studio Desktop Layout Contract

Status: Active
Audience: Anyone changing Studio Desktop/Tauri layout, titlebar, ribbon, sidebar, Library pages, Settings, saved-chat lists, or reader/chat transcript routes.
Scope: `src-surfaces-base/studio/studio.css`, `src-surfaces-base/studio/studio.html`, `src-surfaces-base/studio/studio.js`, `src-surfaces-base/studio/platform/platform.tauri.js`, and generated Desktop Studio output.

## Purpose

This document records the layout rules corrected during the Studio Desktop titlebar/ribbon/sidebar work. These rules are not optional polish. They are the structural contract that prevents repeated regressions where the macOS traffic-light area, sidebar, ribbon menu, title topbar, and right pane shift or get visually cut.

The core model is:

- `.wbShell` starts at the top of the Desktop window.
- The top safe area is owned by the real app compartments: sidebar/rail and right pane.
- The Tauri chrome/ribbon host overlays that safe area.
- Showing or hiding a ribbon menu strip must never push the app layout up or down.
- Expanding a visible ribbon body is different: the measured body height must become real reserved layout height so sidebar and right-pane content move down together instead of being covered by a dropdown overlay.

## Structural Lane Owner

`L-STUDIO-APPLICATION-SHELL` is the home semantic owner of this structural
contract. Its boundary includes `.wbShell`, `.wbStage`,
`.wbSide--sidebar`, `.wbRail`, `.wbTop`, `.wbMain`, app-level route/view
containers, global scroll roots, Desktop chrome/top-safe-area composition, and
Ribbon/Dock host-placement geometry. This ownership statement does not change
any layout rule below.

Feature Lanes retain the meaning and behavior of the content mounted inside
these structures. Reader owns opened-conversation consumption, Renderer owns
content projection, Authoring owns authored actions, and Cockpit Library owns
Library entries/routes/actions. A feature change that must touch a Shell-owned
selector or container uses a temporary narrow lease for the exact structural
slot and preserves this contract; it does not create co-primary ownership.

`L-STUDIO-HOST-INTEGRATION` owns the Tauri/MV3/OS adapter semantics behind
Desktop host APIs, while Application Shell owns their UI placement geometry.
`L-DEVELOPER-BUILD-DELIVERY-SCOPE-STU` owns generation, staging, packaging,
delivery, and validation of the resulting Studio software artifacts. Shared
files such as `studio.html`, `studio.css`, `studio.js`, `S0Y1a` Studio Ribbon,
Dock/Ribbon shell modules, `platform.tauri.js`, and Desktop Tauri files are
classified by the semantics of each change, not assigned wholesale to one
Lane.

## Change Control Gate

The Desktop Studio interface structure is protected. Do not change the Desktop window layout, titlebar/chrome structure, ribbon placement, sidebar top section, route topbar rules, page scroll roots, or Desktop zoom handling without explicit user permission for that specific step.

Before any structural Desktop UI change, the operator must state:

1. The exact user-visible problem being changed.
2. The routes affected: Library, Settings, saved-chat list, folders, reader/chat transcript, Chrome/MV3, or Desktop/Tauri.
3. The files and selectors/functions that will be touched.
4. Whether the change can move `.wbShell`, `.wbStage`, `.wbSide--sidebar`, `.wbRail`, `.wbTop`, `.wbMain`, `.wbTauriDesktopChrome`, or `#studioRibbon`.
5. The expected before/after geometry.
6. The validation commands and runtime/manual checks that will prove the layout did not regress.

Permission is required again for each separate structural step. A broad request to "fix the UI" is not permission to rewrite the Desktop layout model, move the ribbon into document flow, change sidebar top padding, change route topbars, or introduce new top spacers.

Run the static layout guard after any relevant source change:

```sh
node tools/validation/studio/validate-studio-desktop-layout-contract.mjs
```

This guard does not replace runtime validation, but it catches the regressions that repeatedly broke this layout: shell pushed down, fake top strips, hidden ribbon taking layout space, missing CSS zoom compensation, stale topbar route rules, and missing source/dist cache markers.

## Core Rules

1. The Desktop chrome host is overlay-only.
   - `.wbTauriDesktopChrome` must not be a normal layout row above `.wbShell`.
   - It should not reserve document flow height.
   - It exists to host the draggable strip and visible ribbon menu controls over the already-reserved top band.

2. `.wbShell` owns the full Desktop window height.
   - Do not place a full-width spacer above `.wbShell`.
   - Do not push `.wbShell` downward to make room for macOS traffic-light buttons.
   - The sidebar and right pane must visually begin at y=0.

3. The top empty area belongs to each compartment.
   - Sidebar/rail reserve the top safe area with their own padding.
   - Right pane/stage reserves the top safe area with its own grid row.
   - This makes the sidebar background, right-pane background, and the vertical divider continuous from the top of the window.

4. The sidebar divider must be one continuous line.
   - Do not add a separate top-only divider patch.
   - Do not add a glass/transparent strip above the sidebar.
   - Do not let the top segment of the divider be painted by a different element than the rest of the sidebar boundary.

5. The Library page background must not be cut behind the title.
   - Library route background treatment belongs on the right pane/stage when Desktop top space is involved.
   - Do not leave the top band as a blank desktop chrome background while the Library page gradient starts below it.

6. Ribbon menus overlay the top safe area.
   - A visible ribbon menu may paint over the top safe band.
   - A hidden ribbon menu must not take layout space.
   - Hidden ribbon state should hide controls and disable hit testing without changing the size or position of `.wbShell`, `.wbStage`, `.wbSide--sidebar`, `.wbRail`, `.wbTop`, or `.wbMain`.
   - A collapsed visible ribbon menu is only the top menu strip and should use the base top safe band.
   - An expanded visible ribbon body must publish its measured panel height through the Desktop ribbon layout state and push `.wbStage`, `.wbSide--sidebar`, and `.wbRail` down together.

7. Ribbon menu toggle is not ribbon collapse.
   - Library and reader/chat ribbon buttons show or hide the top ribbon menu strip.
   - They must not trigger unrelated ribbon collapse behavior.
   - They must not resize the title topbar or move the sidebar header.
   - Library ribbon tabs are Library-specific. Library uses the Library Home tab and Library actions; reader/chat routes use the reader/chat ribbon tabs.

8. The sidebar logo/title row is fixed in position.
   - It must not move between Library, Settings, saved-chat list, folders pages, and reader/chat transcript routes.
   - It must not move when the ribbon menu is shown or hidden.
   - It must not move when sidebar content scrolls.
   - Sidebar scrolling starts below the fixed logo/title and Library row area.

9. Reader/chat title topbar appears only for reader/chat transcripts.
   - Library, Settings, migrate, folders, saved-chat list, and other non-reader pages must not show the reader title topbar.
   - When a reader/chat ribbon menu is hidden, the reader title topbar may still sit below the reserved top safe area. It must not jump upward into the traffic-light band.

10. Settings follows the same top-safe layout rules as Library.
    - Settings must not show the reader title topbar.
    - Settings must not show stale Library or reader ribbon menu controls.
    - Settings content must start below the same structurally reserved top safe area.

11. Chrome/MV3 Studio must not inherit Desktop titlebar behavior.
    - Desktop-only layout rules must be scoped with `html[data-h2o-runtime="tauri"]`.
    - Chrome Studio must not receive Tauri titlebar padding, app-region rules, or Desktop overlay assumptions.

12. Mac traffic-light buttons stay visible and usable.
    - Do not draw fake traffic-light buttons.
    - Do not cover the native buttons with interactive app controls.
    - Controls near the top band must use no-drag behavior where needed.

13. The top empty/menu area remains draggable in Desktop.
    - The hidden top band should allow moving the app window.
    - Visible ribbon menu whitespace can be draggable.
    - Buttons, inputs, selects, popovers, ribbon tabs, sidebar controls, and appearance controls must be protected from drag regions.

14. Desktop CSS zoom must preserve real window coverage.
    - If Desktop view zoom falls back to CSS `body.style.zoom`, the body and `.wbShell` must compensate with `--h2o-desktop-view-zoom-inverse`.
    - The visual sidebar must still reach the bottom of the app window at every zoom level.
    - Do not use body zoom without inverse viewport sizing.

## Required Structure

The current intended structure is:

```text
body
  .wbTauriDesktopChrome       overlay only; fixed at top; not in normal flow
    .wbTauriDragStrip         invisible drag region
    #studioRibbon             visible ribbon menu when enabled
  .wbShell                    real app grid, starts at y=0
    .wbRail                   collapsed sidebar compartment
    .wbSide--sidebar          expanded sidebar compartment
    .wbStage                  right pane compartment
      #studioRibbon           static MV3-safe source location before Tauri rehome
      .wbTop                  reader/chat title topbar only when eligible
      .wbMain                 page content scroll root
```

For Desktop/Tauri:

- `.wbTauriDesktopChrome` is fixed and transparent.
- `.wbTauriDragStrip` is absolute inside that overlay host.
- `.wbStage` has a first grid row for the top safe band.
- `.wbSide--sidebar` and `.wbRail` reserve the same top safe band internally.
- `#studioRibbon` is rehomed into `.wbTauriDesktopChrome` and positioned over the top safe band.
- The expanded ribbon body height is added to the shared safe band with `--wb-tauri-ribbon-expanded-h`; it must be reset to `0px` when the ribbon is hidden or collapsed.

## Route Rules

The route scope must stay accurate:

- `reader`: active only for opened chat transcript reader routes.
- `library`: active for Library shell pages and Library-owned subpages.
- `settings`: active for Settings.
- `migrate`: active for migration routes.
- `list`: active for saved/pinned/archive style lists that are not the reader.

Route state must clear stale ribbon/topbar state:

- Leaving `reader` clears reader-only ribbon hidden state.
- Leaving `library` clears library-only ribbon hidden state.
- Entering `settings` clears reader snapshot state and must not preserve a visible Library or reader ribbon menu.
- `data-dock-eligible` is true only on eligible reader routes.

## Scroll Rules

1. Page scrollbar placement:
   - Library, folders, saved-chat list, and Settings pages should use the right pane/window edge scroll root, not an internal card/list scrollbar placed beside content.

2. Sidebar scrolling:
   - The sidebar logo/title and Library row remain fixed.
   - Data sections below them scroll.
   - Scrolling the sidebar must not put content under the macOS traffic-light buttons.

3. Reader scrolling:
   - Reader content may scroll in `.wbMain`.
   - Reader title topbar and top safe area must not collapse when the ribbon menu is hidden.

## Appearance And Button Rules

1. Appearance button placement:
   - Desktop: the appearance button belongs with the top menu/action controls, not as a floating page button.
   - Library page actions should be ordered right-to-left as: appearance, ribbon toggle, refresh.
   - Reader/chat title topbar actions should use the same visual button family as Library actions.

2. Ribbon toggle buttons:
   - Library ribbon toggle shows/hides the Library ribbon menu strip.
   - Reader ribbon toggle shows/hides the reader/chat ribbon menu strip.
   - These buttons do not change route, titlebar size, sidebar position, or app grid rows.

3. Refresh buttons:
   - Library refresh refreshes Library data.
   - Reader refresh may be connected to chat transcript refresh behavior later.
   - A placeholder refresh button should still preserve the same button sizing and no-drag behavior.

## Forbidden Fixes

Do not use these approaches to solve top-space/titlebar/ribbon issues:

- Adding a transparent or glass strip above `.wbShell`.
- Making `.wbTauriDesktopChrome` a normal flex/grid row that pushes `.wbShell`.
- Painting a separate sidebar-top rectangle to fake continuity.
- Adding a separate top-only border to repair a broken sidebar divider.
- Moving the sidebar logo/title with route-specific padding.
- Letting hidden ribbon controls occupy layout height.
- Reintroducing native or app title text into the macOS titlebar strip.
- Showing reader title topbar on Library, Settings, folders, migration, or saved-chat list pages.
- Applying Tauri layout rules to Chrome/MV3 Studio.

## Validation Checklist

Before calling a Desktop layout change complete, verify these states:

1. Library, ribbon hidden:
   - No extra strip above the Library page.
   - Sidebar background reaches the top.
   - Right pane background reaches the top.
   - Vertical divider is one continuous line.
   - Library gradient/background is not cut behind the Library title.

2. Library, ribbon shown:
   - Ribbon menu appears over the top safe band.
   - Sidebar and right pane do not shift.
   - Hiding it returns to the same geometry as before.

3. Library, ribbon expanded:
   - Ribbon body is not a dropdown over the page.
   - Sidebar and right pane content are pushed down by the same measured ribbon body height.
   - The Library page remains visible below the ribbon body with no overlap.

4. Settings:
   - No reader title topbar.
   - No stale Library or reader ribbon menu.
   - Same top safe area as Library.
   - Sidebar logo/title position is identical to Library.

4. Reader/chat transcript:
   - Reader title topbar appears only here.
   - Reader ribbon toggle shows/hides the ribbon menu strip.
   - Hiding the ribbon does not move the sidebar logo/title.
   - Hiding the ribbon does not pull the title topbar into the macOS traffic-light row.

5. Sidebar:
   - Logo/title row does not scroll.
   - Library row does not scroll.
   - Sections below them scroll.
   - Expanded and collapsed sidebar states preserve top alignment.

6. Desktop window behavior:
   - Mac traffic-light buttons are visible and usable.
   - Top safe/ribbon whitespace can drag the app window.
   - Appearance/ribbon/refresh/sidebar buttons remain clickable.

7. Chrome/MV3 Studio:
   - No Desktop titlebar top padding appears.
   - Chrome Library behavior is not changed by Tauri-only rules.

## Runtime Probe

Use this in Desktop DevTools to inspect the active geometry:

```js
({
  runtime: document.documentElement.dataset.h2oRuntime,
  route: document.body.dataset.route,
  dockEligible: document.body.dataset.dockEligible,
  css: document.querySelector('link[rel="stylesheet"]')?.href,
  chrome: (() => {
    const e = document.getElementById('studioDesktopChrome');
    if (!e) return null;
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return {
      top: Math.round(r.top),
      height: Math.round(r.height),
      position: cs.position,
      display: cs.display,
      pointerEvents: cs.pointerEvents,
      background: cs.backgroundColor
    };
  })(),
  shell: (() => {
    const e = document.querySelector('.wbShell');
    const r = e?.getBoundingClientRect();
    return r ? { top: Math.round(r.top), height: Math.round(r.height) } : null;
  })(),
  sidebar: (() => {
    const e = document.querySelector('.wbSide--sidebar');
    const r = e?.getBoundingClientRect();
    const cs = e ? getComputedStyle(e) : null;
    return r ? {
      top: Math.round(r.top),
      height: Math.round(r.height),
      paddingTop: cs.paddingTop,
      background: cs.backgroundColor,
      borderRight: cs.borderRightColor
    } : null;
  })(),
  stage: (() => {
    const e = document.querySelector('.wbStage');
    const r = e?.getBoundingClientRect();
    const cs = e ? getComputedStyle(e) : null;
    return r ? {
      top: Math.round(r.top),
      height: Math.round(r.height),
      gridTemplateRows: cs.gridTemplateRows,
      background: cs.backgroundImage || cs.backgroundColor
    } : null;
  })()
})
```

Expected Desktop basics:

- `runtime === "tauri"`
- `.wbShell.top === 0`
- `.wbTauriDesktopChrome.position === "fixed"`
- `.wbTauriDesktopChrome.pointerEvents === "none"`
- `.wbSide--sidebar.top === 0`
- `.wbStage.top === 0`
- `.wbStage.gridTemplateRows` starts with the top safe row.

## Source And Build Notes

After source changes:

```sh
npm run dev:all
SKIP_STALENESS_CHECK=1 node apps/studio/desktop/build-tools/prepare-dist.mjs
npm run dev:check
```

If Desktop still shows old layout:

- Hard reload or disable cache in Tauri DevTools.
- Confirm `src-surfaces-base/studio/studio.html` and `apps/studio/desktop/dist/studio.html` use the latest `studio.css?v=...`.
- Confirm `apps/studio/desktop/dist/studio.css` contains the same Tauri layout block as source.

## Handoff Rule

Any future chat or operator that works on Studio Desktop layout should read this file first. If a requested change conflicts with this contract, stop and ask for explicit approval before editing. If a change intentionally breaks one of these rules, update this contract in the same slice and explain why the old rule no longer applies.
