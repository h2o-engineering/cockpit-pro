# Contract: Core

Status: Active

Purpose:
Define shared route, page-host, registry, and shell boundaries used by H2O internal pages.

## Ownership
- Library Core owns shared registries for owners, services, pages, routes, and views.
- Feature modules own their data and UI. Core only coordinates registration, route dispatch, page hosting, and shared shell utilities.
- Core route parsing must accept registered or reserved H2O views and reject unknown views.
- These Library page/service registries are not executable module admission.
  `L-RUNTIME-KERNEL-SCOPE-EXT` owns Extension bootstrap/module lifecycle and
  `L-RUNTIME-KERNEL-SCOPE-STU` owns Studio bootstrap/module lifecycle.

## Route Contract
- H2O page URLs use `h2o_flsc=1`, `h2o_flsc_view=<view>`, and optional `h2o_flsc_id=<id>`.
- List views such as `library`, `folders`, `labels`, `categories`, `projects`, and Library workspace subsections must not require an id.
- Detail views such as `folder`, `label`, `category`, `tag`, and `project` require an id.
- Route handlers must be registered by the feature owner that owns the page.
- Route dispatch must work on direct URL load, pushState navigation, popstate, and hashchange.

## Page Host Contract
- A single active H2O page root should own the main hosted surface at a time.
- Mounting a feature page should hide or dispose incompatible hosted siblings through PageHost, not by ad hoc DOM removal.
- Leaving H2O routes must restore native ChatGPT surface behavior.

## Forbidden Coupling
- Core must not read or write feature-specific storage.
- Core must not inspect feature catalogs or implement feature business logic.
- Feature owners must not bypass Core route/page-host services when a registered route/page-host path exists.
