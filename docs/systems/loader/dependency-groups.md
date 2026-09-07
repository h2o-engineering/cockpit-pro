# Loader Dependency Groups

Status: Draft / Placeholder

Purpose:
TODO

## Engineering Lane Boundary

`L-RUNTIME-KERNEL-SCOPE-EXT` owns the meaning and enforcement of production
runtime dependency/readiness ordering, including Loader tiers, waves,
scheduling, and admission gates. The existing `config/dev-order.tsv`,
`config/loader-deps.json`, and `config/loader-tiers.json` remain unchanged by
this documentation adoption.

Feature dependencies do not make Runtime the semantic owner of the feature,
and the build tooling that generates loader artifacts is not runtime execution
ownership.
