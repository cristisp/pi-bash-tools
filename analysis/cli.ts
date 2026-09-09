import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { analyzeS4, measure, renderMarkdown, renderS4Markdown, readTelemetry } from './measure.ts';

const args = process.argv.slice(2);
const s4 = args.includes('--s4');

function fail(message: string): never {
	process.stderr.write(`s4: ${message}\n`);
	process.exitCode = 2;
	throw new Error(message);
}

function parseOptions(): {
	positional: string[];
	from?: number;
	to?: number;
	json?: string;
	markdown?: string;
	independentReview: 'pass' | 'fail' | 'pending';
} {
	const positional: string[] = [];
	const values = new Map<string, string>();
	let independentReview: 'pass' | 'fail' | 'pending' = 'pending';
	const valueOptions = new Set(['--from', '--to', '--json', '--markdown', '--independent-review']);
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === '--s4') continue;
		if (!arg.startsWith('--')) {
			positional.push(arg);
			continue;
		}
		const equals = arg.indexOf('=');
		const name = equals >= 0 ? arg.slice(0, equals) : arg;
		let value = equals >= 0 ? arg.slice(equals + 1) : undefined;
		if (!valueOptions.has(name)) fail(`unknown option ${name}`);
		if (value === undefined) {
			value = args[++index];
			if (!value || value.startsWith('--')) fail(`missing value for ${name}`);
		}
		if (!value.trim()) fail(`empty value for ${name}`);
		if (values.has(name)) fail(`duplicate option ${name}`);
		values.set(name, value);
	}
	const time = (name: string): number | undefined => {
		const value = values.get(name);
		if (value === undefined) return undefined;
		const numeric = Number(value);
		const parsed = Number.isFinite(numeric) ? numeric : Date.parse(value);
		if (!Number.isFinite(parsed)) fail(`invalid date or timestamp for ${name}`);
		return parsed;
	};
	const review = values.get('--independent-review');
	if (review !== undefined) {
		if (review !== 'pass' && review !== 'fail' && review !== 'pending')
			fail('--independent-review must be pass, fail, or pending');
		independentReview = review;
	}
	return {
		positional,
		from: time('--from'),
		to: time('--to'),
		json: values.get('--json'),
		markdown: values.get('--markdown'),
		independentReview,
	};
}

function writeArtifacts(
	jsonPath: string,
	markdownPath: string,
	json: string,
	markdown: string,
): void {
	const token = `${process.pid}-${Date.now()}`;
	const jsonTmp = `${jsonPath}.${token}.tmp`;
	const markdownTmp = `${markdownPath}.${token}.tmp`;
	try {
		mkdirSync(dirname(jsonPath), { recursive: true });
		mkdirSync(dirname(markdownPath), { recursive: true });
		writeFileSync(jsonTmp, json, { encoding: 'utf8', mode: 0o600 });
		writeFileSync(markdownTmp, markdown, { encoding: 'utf8', mode: 0o600 });
		renameSync(jsonTmp, jsonPath);
		renameSync(markdownTmp, markdownPath);
	} finally {
		for (const file of [jsonTmp, markdownTmp]) if (existsSync(file)) rmSync(file, { force: true });
	}
}

let options: ReturnType<typeof parseOptions>;
try {
	options = parseOptions();
} catch {
	process.exitCode = process.exitCode || 2;
	process.exit();
}

const agentDir = options.positional[0] ?? getAgentDir();
const producerInvocationPath = options.positional[1];
if (!s4) {
	const cutoffArg = Number(process.env.MEASURE_CUTOFF ?? '');
	const cutoff = Number.isFinite(cutoffArg) && cutoffArg > 0 ? cutoffArg : undefined;
	const markdown = renderMarkdown(measure(agentDir, cutoff, producerInvocationPath));
	writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'MEASUREMENT.md'), markdown);
	process.stdout.write(markdown);
} else {
	const decision = analyzeS4(readTelemetry(agentDir), {
		from: options.from,
		to: options.to,
		independentReview: options.independentReview,
	});
	const jsonPath = options.json ?? join(agentDir, 'subagent-herdr.s4-decision.json');
	const markdownPath = options.markdown ?? join(agentDir, 'subagent-herdr.s4-decision.md');
	try {
		writeArtifacts(
			jsonPath,
			markdownPath,
			`${JSON.stringify(decision, null, 2)}\n`,
			renderS4Markdown(decision),
		);
	} catch (error) {
		process.stderr.write(`s4: could not write artifacts: ${String(error)}\n`);
		process.exitCode = 1;
	}
	process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
	if (decision.status !== 'ENFORCE_CANDIDATE') process.exitCode = process.exitCode || 1;
}
