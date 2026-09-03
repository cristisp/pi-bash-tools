import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { measure, renderMarkdown } from './measure.ts';

const agentDir = process.argv[2] ?? getAgentDir();
const cutoffArg = Number(process.env.MEASURE_CUTOFF ?? '');
const cutoff = Number.isFinite(cutoffArg) && cutoffArg > 0 ? cutoffArg : undefined;
const markdown = renderMarkdown(measure(agentDir, cutoff));
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'MEASUREMENT.md'), markdown);
process.stdout.write(markdown);
