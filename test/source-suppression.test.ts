import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitWorkspace, createFixture, currentRef, git } from '../src/git.ts';
import { currentPolicy } from '../src/policy.ts';
import { applyApproved, approveCandidate, evidenceVerdict } from '../src/protocol.ts';
import { verifyCandidate } from '../src/runner.ts';
import { digest, runId } from '../src/support.ts';
import type { CheckReport } from '../src/types.ts';

test(
  'explicit boundary: source-level suppression remains allowed under fixed checker options',
  { timeout: 30_000 },
  async () => {
    const fixture = await createFixture('source-suppression');
    const config = await readFile(join(fixture.workspace, 'tsconfig.json'));
    const policy = await currentPolicy();
    const source =
      'export function mayRetry(method, status) {\n' +
      "  return (method === 'GET' || method === 'HEAD') &&\n" +
      '    (status === 429 || (status >= 500 && status <= 599));\n' +
      '}\n';
    const verifySource = async (text: string) => {
      await writeFile(join(fixture.workspace, 'src/retry-policy.ts'), text);
      const candidate = {
        id: runId(),
        base: fixture.base,
        ...(await commitWorkspace(fixture, 'Source suppression boundary', fixture.base)),
      };
      const evidence = await verifyCandidate(fixture, candidate);
      assert.deepEqual(evidence.candidate, candidate);
      assert.equal(evidence.policyDigest, digest(policy));
      for (const result of evidence.results) {
        const report = result.report as CheckReport;
        assert.equal(report.candidateCommit, candidate.commit);
        assert.equal(report.candidateTree, candidate.tree);
        assert.equal(report.policyDigest, evidence.policyDigest);
        assert.equal(report.nonce, result.request.nonce);
        assert.equal(report.sourceConsistent, true);
        assert.equal(result.process.directChildExitConfirmed, true);
      }
      const runtime = evidence.results.find(
        (result) => result.request.checker === 'runtime-contract',
      )!;
      const types = evidence.results.find((result) => result.request.checker === 'strict-types')!;
      assert.equal(runtime.process.exitCode, 0);
      assert.ok((runtime.report as CheckReport).checks.every((check) => check.passed));
      return { candidate, evidence, runtime, types };
    };

    const plain = await verifySource(source);
    assert.equal(plain.types.process.exitCode, 2);
    assert.equal(
      (plain.types.report as CheckReport).checks[0]!.detail,
      "Parameter 'method' implicitly has an 'any' type.\n" +
        "Parameter 'status' implicitly has an 'any' type.",
    );
    const refused = await approveCandidate(
      fixture,
      plain.candidate,
      plain.evidence,
      'Local reviewer',
      `APPLY ${plain.candidate.commit} ${digest(plain.evidence)}`,
    );
    assert.equal(refused.verdict.code, 'CHECK_FAILED');
    assert.equal(refused.approval, undefined);
    assert.equal(await currentRef(fixture), fixture.base);

    // TypeScript intentionally honors this directive. Fixed compiler options do
    // not implement a separate policy banning source-level suppression.
    const suppressed = await verifySource('// @ts-nocheck\n' + source);
    assert.deepEqual(await readFile(join(fixture.workspace, 'tsconfig.json')), config);
    assert.deepEqual(
      (suppressed.runtime.report as CheckReport).checks,
      (plain.runtime.report as CheckReport).checks,
    );
    assert.equal(suppressed.types.process.exitCode, 0);
    assert.equal(
      evidenceVerdict(suppressed.evidence, suppressed.candidate, await currentPolicy()).code,
      'EVIDENCE_COMPLETE',
    );
    const approved = await approveCandidate(
      fixture,
      suppressed.candidate,
      suppressed.evidence,
      'Local reviewer',
      `APPLY ${suppressed.candidate.commit} ${digest(suppressed.evidence)}`,
    );
    assert.equal(approved.verdict.code, 'APPROVED');
    assert.ok(approved.approval);
    assert.equal(approved.approval.evidenceDigest, digest(suppressed.evidence));
    assert.equal(await currentRef(fixture), fixture.base);
    assert.equal(
      (await applyApproved(fixture, suppressed.candidate, suppressed.evidence, approved.approval))
        .code,
      'CAS_APPLIED',
    );
    assert.equal(await currentRef(fixture), suppressed.candidate.commit);
    assert.equal(
      (await git(fixture, ['show', `${suppressed.candidate.commit}:src/retry-policy.ts`])).stdout,
      '// @ts-nocheck\n' + source,
    );
    assert.equal(digest(await currentPolicy()), digest(policy));
  },
);
