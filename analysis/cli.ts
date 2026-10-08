import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { measure, renderMarkdown } from './measure.ts';

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const agentDir = positional[0] ?? getAgentDir();
const producerInvocationPath = positional[1];
const cutoffArg = Number(process.env.MEASURE_CUTOFF ?? '');
const cutoff = Number.isFinite(cutoffArg) && cutoffArg > 0 ? cutoffArg : undefined;
const markdown = renderMarkdown(measure(agentDir, cutoff, producerInvocationPath));
const target = join(dirname(fileURLToPath(import.meta.url)), 'MEASUREMENT.md');
writeFileSync(target, markdown);
process.stdout.write(markdown);
