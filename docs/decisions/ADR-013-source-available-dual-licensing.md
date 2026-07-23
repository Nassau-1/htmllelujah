# ADR-013: Source-available noncommercial licensing

- Status: Accepted
- Date: 2026-07-23

## Context

HTMLlelujah's source is public so people can inspect, learn from, modify, and improve
the software. The licensor also wants ordinary business and other commercial use to
require a separately negotiated license.

Those requirements cannot be described accurately as Open Source. The
[Open Source Definition](https://opensource.org/osd) prohibits restrictions by field
of endeavor, including business use. Strong-copyleft licenses can require source
disclosure when their conditions are triggered, but they still permit commercial use
without requiring payment to the original licensor.

No standard license reviewed combines a permanent noncommercial-only public grant,
mandatory publication of all modified source, and a paid commercial exception.
Creating a novel hybrid would add interpretation and enforcement risk beyond an
engineering decision.

## Decision

License HTMLlelujah's original source and official compiled distributions under the
unmodified
[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0),
with the supported `Required Notice` identifying the copyright holder.

The implementation rules are:

- `LICENSE` is the one authoritative public grant and retains the canonical PolyForm
  text.
- The Windows installer displays `LICENSE` and installs it as `LICENSE.txt`.
- `COMMERCIAL-LICENSING.md` provides a contact path but grants no commercial rights.
  Commercial rights require a separate written agreement.
- First-party package metadata uses the SPDX identifier
  `PolyForm-Noncommercial-1.0.0`.
- Project material calls this model **source-available**, not Open Source, free
  software, or copyleft.
- The public grant covers original HTMLlelujah software and official compiled
  distributions. It does not claim user presentation content or grant trademark
  rights in the project name or logo.
- External code, documentation, design, asset, and translation contributions remain
  closed until a contributor agreement grants the rights needed for both the public
  license and separate commercial licensing.
- Third-party components and assets remain under their own licenses. Neither PolyForm
  nor a future commercial agreement changes those obligations.

Previously delivered binaries remain governed by the terms delivered with those
copies. Release candidates built from this decision onward use the new public
license.

## Consequences

- Noncommercial uses, changes, and distribution are permitted according to PolyForm,
  including its defined personal uses and noncommercial organizations.
- Work for a commercial purpose, ordinary internal for-profit business use, paid
  services, commercial integration, and other anticipated commercial applications
  require a separate written license unless the use is otherwise permitted by the
  public license or law.
- Anyone distributing a permitted copy must pass on the PolyForm terms and required
  notice.
- PolyForm does not require modified or surrounding source code to be published.
  Documentation must not imply that it does.
- The licensor must control the relevant contribution rights before offering a
  commercial license covering community-authored code.
- The public `Nassau-1` notice must be backed by private chain-of-title records, and
  any commercial agreement must identify the correct legal contracting party.
- Any public binary distribution still requires the independent third-party
  compliance and legal checks recorded under `docs/legal/`.

## Rejected options

- AGPL or another Open Source copyleft license: strong reciprocity, but commercial use
  remains permitted without mandatory payment.
- Parity: broad contribution obligations, but commercial use remains available by
  complying with its public terms.
- Prosperity: includes a 30-day commercial trial that is not part of the intended
  model.
- Business Source License: permits non-production business use and requires a later
  change to an Open Source license.
- A Creative Commons noncommercial/share-alike license: Creative Commons does not
  recommend its licenses for software.
- A custom noncommercial-plus-copyleft rider: no standard text or qualified legal
  review currently supports that hybrid.
