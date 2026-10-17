'use strict';
// Loaded explicitly in the existing state worker only. Parent and Git clocks stay real.
const { readFileSync, appendFileSync, realpathSync } = require('node:fs');
const { join, relative, isAbsolute } = require('node:path');
const lab = realpathSync(join(__dirname, '../../.lab'));
const directory = realpathSync(process.env.VCL_EXPIRY_CLOCK_DIRECTORY || '');
const part = relative(lab, directory);
if (!part || part.startsWith('..') || isAbsolute(part))
  throw new Error('Clock must stay in the generated lab.');
const clock = join(directory, 'clock.json');
const journal = join(directory, 'events.jsonl');
Date.now = () => {
  const { now } = JSON.parse(readFileSync(clock, 'utf8'));
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid experiment logical clock.');
  const stack = new Error().stack || '';
  if (stack.includes('requireFreshAuthorization')) {
    const caller = stack.includes('selectPreparedState')
      ? 'selectPreparedState'
      : stack.includes('prepareStateChange')
        ? 'prepareStateChange'
        : 'unrecognized';
    appendFileSync(
      journal,
      JSON.stringify({ event: 'worker-clock-read', detail: { caller, now } }) + '\n',
    );
  }
  return now;
};
