# Benchmarks

Only measured results are reported here.

## Smart Read

The specific Smart Read benchmark measured **-25.90% input tokens** and **-39.14% returned bytes**. This is not a claim about all Forge tasks.

## Snapshot Edit 3B

The measured overhead was approximately **+1.0% tokens** versus vanilla. The stale-protection evaluation blocked **2/2** real stale edits and avoided **1** false stale result.

## Reactive Diagnostics

Available validation recorded **1/1** introduced Python error detected and corrected, with **0** false positives in the available tests.

## Task Progress Monitor

Unit/regression tests, deterministic validation, and manual TUI validation passed. The widget adds **0 model-facing token overhead**. Its coding denominator remains four through retries and recovery.

## Scope

A legacy engineering benchmark is intentionally not used for any global Forge-performance claim.
