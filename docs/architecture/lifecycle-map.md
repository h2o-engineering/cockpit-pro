# Architecture: Lifecycle Map

Status: Active

Purpose:
Map H2O internal page lifecycle responsibilities.

## Engineering Lane Boundary

`L-RUNTIME-KERNEL-SCOPE-EXT` owns Extension module admission and execution
lifecycle. `L-RUNTIME-KERNEL-SCOPE-STU` owns Studio module admission and
execution lifecycle. Page/route lifecycle meaning remains with the applicable
feature and Application Shell owners; registering a page is not the same as
admitting its executable module.

## Boot Order
- Core services boot before feature owners that depend on them.
- Feature owners register owners, services, pages, and routes idempotently.
- Source scanners bind observers and listeners once.
- Runtime ordering/readiness services make these modules operational without
  taking ownership of their feature semantics.

## Page Lifecycle
- Opening an H2O route dispatches to the registered feature owner.
- Mounting a new H2O page uses PageHost to manage existing hosted surfaces.
- Leaving H2O routes restores native ChatGPT page behavior.

## Cleanup
- Observers, scroll listeners, scan timers, title-reapply timers, and route retries must not keep forcing H2O behavior after the active route leaves H2O.
- Browser back/forward must not depend on old mounted DOM nodes.
