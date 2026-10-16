/** Deliberately weak comparison. Never used as evidence by the approval protocol. */
import { join } from 'node:path';
import ts from 'typescript';
import { assertOwnedPath } from './support.ts';

const snapshot = process.argv[2];
if (!snapshot) throw new Error('A generated comparison snapshot is required.');
await assertOwnedPath(snapshot);
const parsed = ts.readConfigFile(join(snapshot, 'tsconfig.json'), ts.sys.readFile);
const configuration = ts.parseJsonConfigFileContent(parsed.config, ts.sys, snapshot);
const program = ts.createProgram(configuration.fileNames, configuration.options);
const diagnostics = [
  ...(parsed.error ? [parsed.error] : []),
  ...configuration.errors,
  ...ts.getPreEmitDiagnostics(program),
];
process.stdout.write(
  JSON.stringify({
    comparisonOnly: true,
    candidateConfiguredStrict: configuration.options.strict,
    candidateConfiguredNoCheck: configuration.options.noCheck,
    diagnostics: diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')),
    passed: diagnostics.length === 0,
  }) + '\n',
);
process.exitCode = diagnostics.length === 0 ? 0 : 2;
