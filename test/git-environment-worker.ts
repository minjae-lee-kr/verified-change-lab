import { createFixture, currentRef, git, prepareCandidate } from '../src/git.ts';
import { applyApproved, approveCandidate } from '../src/protocol.ts';
import { verifyCandidate } from '../src/runner.ts';
import { digest } from '../src/support.ts';

// Invoked in a child so a deliberately contaminated environment never reaches
// this test runner or concurrent tests. All application code is unchanged.
const fixture = await createFixture('ambient-git');
const injectedConfig = await git(fixture, ['config', '--get', 'harness.ambient'], {}, true);
const injectedParameters = await git(fixture, ['config', '--get', 'harness.parameters'], {}, true);
let candidateCommit: string | undefined;
let approvalCode: string | undefined;
let applyCode: string | undefined;
if (process.argv[2] === 'approve') {
  const candidate = await prepareCandidate(fixture);
  const evidence = await verifyCandidate(fixture, candidate);
  const approved = await approveCandidate(
    fixture,
    candidate,
    evidence,
    'Synthetic environment reviewer',
    `APPLY ${candidate.commit} ${digest(evidence)}`,
  );
  approvalCode = approved.verdict.code;
  if (!approved.approval) throw new Error(`Approval failed: ${approvalCode}`);
  applyCode = (await applyApproved(fixture, candidate, evidence, approved.approval)).code;
  candidateCommit = candidate.commit;
}
console.log(
  JSON.stringify({
    fixture,
    injectedConfigExitCode: injectedConfig.exitCode,
    injectedParametersExitCode: injectedParameters.exitCode,
    candidateCommit,
    approvalCode,
    applyCode,
    current: await currentRef(fixture),
  }),
);
