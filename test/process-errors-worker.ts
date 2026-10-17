import { boundedProcess } from '../src/process.ts';

const [mode, cwd] = process.argv.slice(2);
if (!cwd) throw new Error('The owned process test needs a working directory.');
const usesIpc = mode === 'after-exit' || mode === 'while-alive';
const program = usesIpc
  ? `process.send({ type: 'ready' });
     process.on('message', (message) => {
       if (message.type === 'write') process.stdout.write('{"complete":true}\\n');
       if (message.type === 'exit') process.exit(0);
     });`
  : `process.stdout.write('child-started\\n');`;
const result = await boundedProcess(process.execPath, ['-e', program], {
  cwd,
  timeoutMs: 1000,
  maxOutputBytes: 1024,
  ...(usesIpc
    ? {
        ipc: {
          onMessage(message, child) {
            if (
              typeof message !== 'object' ||
              message === null ||
              !('type' in message) ||
              message.type !== 'ready'
            )
              return;
            if (mode === 'after-exit') {
              child.once('exit', () => {
                // Deliberate fault after actual exit 0: a complete payload must not hide pipe loss.
                child.stdout!.emit(
                  'error',
                  Object.assign(new Error('Controlled stdout loss after exit'), { code: 'EIO' }),
                );
              });
            }
            let output = '';
            const afterPayload = (chunk: Buffer) => {
              output += chunk.toString('utf8');
              if (!output.includes('\n')) return;
              child.stdout!.off('data', afterPayload);
              if (output !== '{"complete":true}\n')
                throw new Error('Unexpected controlled payload');
              if (mode === 'after-exit') child.send({ type: 'exit' });
              else {
                child.stderr!.emit(
                  'error',
                  Object.assign(new Error('Controlled stderr loss while child waits'), {
                    code: 'EIO',
                  }),
                );
              }
            };
            child.stdout!.on('data', afterPayload);
            child.send({ type: 'write' });
          },
        },
      }
    : {}),
});
console.log(JSON.stringify(result));
