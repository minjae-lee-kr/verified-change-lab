# Does rolling back code make an approval reusable?

[한국어](state-envelope.ko.md) · [Main experiment](../README.md)

The original lab updates a code ref conditionally. After an acknowledgement is lost,
reading that ref tells us which code is selected now. It does not tell us whether an
approval was consumed: another writer can restore the old value, allowing the same
still-fresh approval to pass its original comparison again.

This separate experiment changes the storage contract. An immutable Git commit holds
both the selected code OID and operation receipts. One ref selects that state commit.
The operation ID is the exact approval digest, so retrying the same approval does not
invent another identity. The existing real checkers and local approval binding still
gate a new selection. They do not authenticate a reviewer.

[Compare the recorded states](https://minjae-lee-kr.github.io/research/approval-memory/)
from source revision `23731a1`. The reader follows a saved run; the command below
creates a new one.

## Run the fixed traces

From the repository root, after the normal frozen dependency install:

```sh
pnpm state:experiment
```

The command prints a new `.lab/state-envelope-runs/<run-id>/report.json` path. It never
replaces `dist/report.json` or a previous capture. The JSON includes actual Git commands,
checker outputs, IPC phases, observed process closure, state OIDs and source fingerprints.
An execution error, missing case or failed observation makes the command fail.
Dirty-source runs are marked as such; a new run is not a historical published capture.

The separate [record checker](../src/state-envelope-check.ts) derives the fixed outcomes
from captured states, receipts, worker phases and process closure. It correlates each
state body/OID and parent list with successful `git show` entries, and checks the CAS
operands and named candidate-retention ref in the transcript. The producer's green
flags alone are insufficient. This is internal consistency checking of a trusted local
record, not a signed attestation or a reconstruction of every possible Git history.
The post-retry final ref read and the later captured-OID read have distinct observation
anchors. Their adjacent Git read blocks and order are checked; an earlier matching
read cannot substitute for the claimed later observation.

The expected distinctions are deliberately small:

| Controlled boundary                                                    | Selection and receipt after the worker exits                                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Separate code-ref update, then stop before receipt write               | Candidate selected; receipt absent. A separate successful-path control writes the receipt.                      |
| State object prepared, then stop before state CAS                      | Previous selection and previous receipts remain selected. The prepared object can exist without being selected. |
| State CAS acknowledged by Git, then stop before caller acknowledgement | Candidate and receipt are read together from the selected state OID. The caller acknowledgement is absent.      |
| Select the old code in a new state, preserving receipts                | The same approval is already recorded; no new transition is issued.                                             |
| Rewind the entire state ref to its initial commit                      | The retained memory is gone. The same approval can execute again while still fresh.                             |

The parent stops a real owned Node worker at an IPC barrier and waits for its actual
exit. The barriers are between completed Git commands. They do not interrupt a Git
rename or simulate power loss. Deadlines bound failures; they do not choose the order.
A separate successful-path control restores the base ref and starts a new worker,
which selects the candidate and writes the receipt. It does not resume the
interrupted attempt.

A separate regression holds two real workers at the same prepared-state barrier,
then releases both. Exactly one conditional ref update is acknowledged. With the
same approval, both re-observations return `ALREADY_RECORDED`; with distinct
candidates and approvals, the loser observes `BASE_CHANGED`. The test derives the
winner from process results and the selected receipt. It does not measure physical
lock overlap, fairness or throughput, and adds no cases to the saved five-trace run.

## The reader contract changes too

Capture the state ref once, then resolve **both** fields through that immutable OID:

```text
state ref ──capture──> state commit
                       ├─ selectedCandidate: code OID
                       └─ receipts: approval digest → recorded selection
```

The reader control captures the initial state, lets the writer select the candidate,
then reads again. An old selection combined with receipts from a fresh ref read mixes
versions. Resolving the original captured OID still returns the original pair.
This is a recorded two-version observation, not a general linearizability proof.

## Why this is not a drop-in fix

- **The ref is now metadata.** A deployment tool expecting a code commit cannot use
  it unchanged. Consumers need an extra resolution step and must share one captured OID.
- **Approval includes the new transition code.** The state protocol and worker are in
  the shared policy fingerprint. Changing either also invalidates approvals for the
  original code-ref path: a conservative cost of one shared policy. Evidence freshness
  is checked again after preparation, but that clock check is not atomic with Git CAS.
- **Retention is part of the contract.** Cooperative writers must preserve receipts.
  A prepared transition must have its exact expected state as its only parent.
  This fixture caps them at 16; it implements no pruning policy. Rewriting the envelope
  costs space and all writers contend on one pointer. No throughput claim is measured.
- **Code objects need retention too.** The generated candidate refs retain them.
  A JSON string containing a code OID is not itself a Git garbage-collection edge.
- **A local writer still controls history.** Ref rewinds and fabricated objects are
  not prevented by hashes. The negative control intentionally rewinds the whole state.

This does not deploy code or perform an external effect. It does not establish
production exactly-once execution, durable actor attribution, power-loss recovery or
a policy for arbitrary repository writers. The original five-case report stays separate.

## Sources behind the decision

- [FoundationDB's unknown-result guidance](https://apple.github.io/foundationdb/developer-guide.html#transactions-with-unknown-results)
  distinguishes a retained operation marker from a new attempt. Its later error-handling
  section also distinguishes settled unknown results from cancellation with work still
  in flight; this fixture uses observed worker exit, not a database guarantee.
- [TigerBeetle's reliable submission guide](https://docs.tigerbeetle.com/coding/reliable-transaction-submission/)
  keeps identity stable across retries. That principle motivates the approval digest;
  the financial system's guarantees do not transfer to this local experiment.
- [Jepsen's linearizability model](https://jepsen.io/consistency/models/linearizable)
  makes the observed object and operation order explicit. Here that object is one state
  ref, not the code ref, receipts, deployment and arbitrary side effects together.
- [Git's update-ref documentation](https://git-scm.com/docs/git-update-ref)
  provides the old-value condition and explicitly limits concurrent-reader visibility
  across multiple refs. Coupled fields are therefore read from one immutable state object.

Read the small protocol in [`src/state-envelope.ts`](../src/state-envelope.ts), the
interruption boundaries in [`src/state-envelope-worker.ts`](../src/state-envelope-worker.ts),
and the actual traces in [`src/state-envelope-experiment.ts`](../src/state-envelope-experiment.ts).
