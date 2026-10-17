# Checked before expiry. Selected after it.

[한국어](approval-expiry.ko.md) · [State-envelope experiment](state-envelope.md)

An approval can be valid at the last freshness check and expired when Git selects
the change. Rechecking after preparation narrows that interval; it does not make
the clock predicate part of the ref transaction.

This experiment runs the existing state worker and actual Git commands twice.
It changes no approval lifetime, evidence payload or transition policy. Only the
worker's `Date.now` uses a controlled logical clock. The parent and Git use their
ordinary clocks; five minutes of wall time do **not** elapse.

| Controlled placement                                                                                               | Last worker check | Observed local result                                                                     |
| ------------------------------------------------------------------------------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------- |
| Advance the clock at the worker's preparation barrier, then continue                                               | After expiry      | Freshness refusal; initial ref and empty receipt set remain                               |
| Let that check pass, then pause Git's `reference-transaction` hook at `prepared`; advance the clock and release it | Before expiry     | Git commits the ref after logical expiry; the selected state retains the approval receipt |

In the second control the parent reads the old ref while Git is paused. The hook
then observes the expired logical clock before returning, and again in Git's
`committed` phase. The worker acknowledgement and a fresh ref/state read agree.
The timeout is a failure bound, never the mechanism used to choose this order.

Git 2.54 and later also emit `preparing`, before refs are locked. The hook records
that phase without pausing; the checker validates its position and transaction if
present. It still requires the later `prepared` barrier and `committed` observation.

## Run and inspect

From the repository root, with the README's Node/Git/pnpm requirements:

```sh
pnpm install --frozen-lockfile
pnpm expiry:experiment
node --test test/approval-expiry.test.ts
```

The command takes no arguments. It creates fresh synthetic repositories and a
report under `.lab/approval-expiry-runs/<run-id>/report.json`; older runs remain.
The report names the source revision, dirty/clean status, file hashes, Node/Git
versions and the two clock domains. Its bounded command captures normalize local
paths to `<project>`; these displayed strings are not untouched terminal bytes.

[`check.ts`](../experiments/approval-expiry/check.ts) derives each fixed outcome
from the worker clock reads, IPC phases, hook transaction, anchored Git reads,
process result and receipt. It does not trust a producer's `passed` label. The
test runs both controls and rejects altered clocks, missing barriers, changed
ref/receipt observations and process failures. Missing evidence, unknown results
and timeouts fail the experiment. This is internal consistency checking of an
unsigned local report, not execution attestation.

## The choice this exposes

“May begin while valid” and “must take effect before expiry” are different contracts.
Another check immediately before `update-ref` still leaves an interval. A strict
completion deadline needs authority that evaluates time and performs the transition
under the same contract, or a documented weaker rule. This experiment implements
neither a new authority nor a repair. A prepared hook is observation instrumentation,
not a suggested production authorization mechanism.

The selected object is one local Git ref, not a deployment or external action.
No claim covers clock skew, hostile writers, power loss or authenticated approval.
The original five-case and state-envelope captures retain their own revisions.

Git documents the hook's [transaction phases](https://git-scm.com/docs/githooks/2.54.0#_reference_transaction)
and [`update-ref`'s old-value condition](https://git-scm.com/docs/git-update-ref).
Neither adds an application expiry predicate to CAS.
