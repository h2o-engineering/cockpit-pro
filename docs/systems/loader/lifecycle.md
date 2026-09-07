# Loader Lifecycle

Status: Draft / Placeholder

Purpose:
TODO

## Engineering Lane Boundary

`L-RUNTIME-KERNEL-SCOPE-EXT` owns Extension module registration, activation,
on-demand loading, navigation/remount behavior, deactivation/disposal where
applicable, MV3 restart/dormancy execution semantics, readiness, health, and
runtime failure/recovery.

Feature Lanes own feature lifecycle meaning inside their modules. Runtime owns
how accepted modules become and remain operational; it does not own every
module that participates in the lifecycle.
