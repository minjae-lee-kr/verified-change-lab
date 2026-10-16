# Verified Change Lab

**A check passed. Did we select the code it checked?**

[한국어](README.ko.md) · [Design and trust boundaries](docs/design.md)

An automation experiment about keeping verification attached to a change. The naive path checks a candidate, waits for approval, then commits a workspace that has changed. A real runtime check confirms that the selected code breaks the contract. The protected path selects the exact verified commit.

Artifact identity is only half the problem. A candidate can also weaken its own checker: `strict: true` together with `noCheck: true` makes a real TypeScript compiler report green on code with type errors. The trusted checker supplies its own options and source inventory, detects the errors and refuses approval.

## Run locally

Requires **Node 24.12–24.x**, Git and **pnpm 11.25.0**. No credentials or network calls after installation.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm experiment
pnpm serve
```

Open **http://127.0.0.1:4318** for the generated report. It defaults to Korean for a Korean browser, supports English and preserves the selected case and open evidence panels when switching languages.

## What the experiment makes visible

| Case                 | Observed result                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Workspace drift      | The naive path selects unchecked code; its runtime check fails. The protected path selects the verified commit.                   |
| Weakened evidence    | Empty checks and candidate-controlled compiler settings cannot satisfy the independent verification policy.                       |
| Evidence reuse       | Another candidate's evidence and expired evidence are refused.                                                                    |
| Competing approvals  | Two processes race from one base; exactly one conditional Git ref update succeeds.                                                |
| Lost acknowledgement | The executor is terminated after Git accepts the update. Reconciliation observes the current ref without claiming who changed it. |

These are real Git objects, separate checker processes, compiler runs and local ref updates. The report uses **scripted approvals**; the expiry case injects evaluation time rather than waiting five minutes. Each case retains its observations and command transcript.

Three decisions are worth reviewing:

- **Bind the artifact and the policy.** Evidence belongs to an immutable commit/tree and independently defined checks. A check's name and presence do not establish what it checked.
- **Make approval conditional on current state.** The selected candidate and expected base are passed to Git's conditional ref update. A competing approval cannot silently overwrite a different candidate.
- **Keep observation separate from attribution.** After an acknowledgement disappears, reading the ref establishes its current value. It does not establish which executor changed it or whether an earlier change was later undone.

The [design notes](docs/design.md) explain evidence coverage, process cleanup, the A-B-A counterexample and the limits of source fingerprints. They also map each decision to its implementation.

## Try an explicit manual approval

```sh
pnpm lab prepare
```

Review the printed diff, exact commit, required checks and evidence digest. The command prints exact `approve`, `apply` and `reconcile` commands. Approval records a local decision; applying it changes only `refs/heads/release` in that generated fixture. Evidence expires five minutes after verification starts. [Manual flow and validation rules](docs/design.md#manual-approval).

## Scope

Original synthetic source; no employer implementation, production results or LLM calls. This demonstrates a change-control boundary useful to automated tooling, not a model's capabilities.

All Git mutations stay in generated repositories under the ignored `.lab/` directory. No command accepts a user repository, publishes a branch or deploys code. Raw evidence stays in `.lab/`; a report with local paths sanitized is written to `dist/report.json`, with source fingerprints, runtime versions and Git dirty-state provenance.

The runner trusts its local source and processes. It is **not a sandbox or authenticated approval system**; local writers can forge unsigned records. A successful conditional ref update is **not a one-time execution guarantee**: the A-B-A test demonstrates the limit. The five-case report verifies its declared fixture contract, not general correctness. [Full boundaries and tradeoffs](docs/design.md#boundaries-and-tradeoffs).

MIT licensed. Built with established [Git conditional updates](https://git-scm.com/docs/git-update-ref), [Node processes](https://nodejs.org/api/child_process.html) and [TypeScript checks](https://www.typescriptlang.org/tsconfig/noCheck.html).
