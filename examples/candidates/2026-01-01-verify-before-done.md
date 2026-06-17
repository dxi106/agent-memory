---
id: 2026-01-01-verify-before-done
title: Verify behavior end-to-end before claiming a task is complete
category: workflow
confidence: 0.35
created: '2026-01-01'
source: reflection
scope:
  repos:
    - example-app
---
**Rule:** For scripts, tooling, or anything with side effects, actually run the thing against real services and observe the result before reporting it as done — structural/unit tests alone don't prove host-side behavior.

**Why:** The agent declared a setup script working based on passing unit tests, but the script failed on first real run because it never exercised the live dependency.
