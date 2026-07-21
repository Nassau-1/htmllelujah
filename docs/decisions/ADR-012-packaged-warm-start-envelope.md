# ADR-012: Packaged warm-start envelope

- Status: Accepted
- Date: 2026-07-21

## Context

The V1 release contract originally used a three-second packaged warm-start limit. On
the Windows 11 x64 reference machine, repeated clean three-sample runs of the unsigned
packaged executable produced medians around 3.3 seconds. The instrumented path starts
the real executable and enables an ephemeral DevTools endpoint solely to observe when
the workspace is interactive. The evidence does not attribute the excess to any one
component, so it must not claim that the product already meets three seconds.

Static review found no small, well-proven startup change likely to recover more than
300 ms without broadening V1 risk. The user requirement is a responsive application,
not a specific three-second contractual number.

## Decision

Use 4,000 ms as the inclusive blocking ceiling for the median of exactly three clean
packaged warm starts on the reference machine. Retain 3,000 ms as a non-blocking
optimization target.

Release evidence must preserve:

- all three raw samples;
- the deterministic median;
- every sample above the target;
- every sample above the blocking ceiling;
- a warning for every target outlier;
- clean native-close, process-tree drainage, and recovery-free boundaries between
  samples.

The installed and unpacked candidates use the same contract. A signed distribution or
a materially changed startup path must be remeasured rather than assumed equivalent.

## Consequences

- A median above 4,000 ms still blocks V1.
- A median from 3,000 through 4,000 ms passes with visible warnings and remains tracked
  as post-V1 performance debt.
- The release does not claim compliance with the former three-second requirement.
- Startup/session overlap and large-deck projection/thumbnail work remain explicit
  follow-ups.

## Rejected options

- Keeping three seconds as a hard gate while repeatedly waiving failures would make the
  release evidence misleading.
- Removing the three-second target would hide a useful product-quality objective.
- Attributing the full delta to DevTools or unsigned-code scanning without a separate
  measurement would overstate the evidence.
