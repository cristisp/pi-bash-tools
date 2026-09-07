import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Mode = 'prepare' | 'run' | 'analyze';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultStreamPath = join(
	tmpdir(),
	'agent-space',
	'subagent-herdr',
	'bash-tools-invocations.jsonl',
);

function shellQuote(value: string): string {
	return process.platform === 'win32'
		? `'${value.replaceAll("'", "''")}'`
		: `'${value.replaceAll("'", "'\\''")}'`;
}

function usage(): void {
	console.log(`Usage:
  node analysis/collect-s5-telemetry.ts prepare [options]
  node analysis/collect-s5-telemetry.ts run [options] -- <command> [args...]
  node analysis/collect-s5-telemetry.ts analyze [options]

Options:
  --stream <path>       Producer JSONL path.
  --agent-dir <path>    Pi agent directory. Defaults to ~/.pi/agent.
  --reset               Remove the existing stream before collecting.
  --help                Show this help.

Examples:
  node analysis/collect-s5-telemetry.ts prepare --reset
  node analysis/collect-s5-telemetry.ts run --reset -- pi
  node analysis/collect-s5-telemetry.ts analyze
`);
}

function prepareStream(streamPath: string, reset: boolean): void {
	mkdirSync(dirname(streamPath), { recursive: true });
	if (reset && existsSync(streamPath)) rmSync(streamPath);
	if (!existsSync(streamPath)) appendFileSync(streamPath, '');
}

function streamSummary(streamPath: string): void {
	if (!existsSync(streamPath)) {
		console.log(`Producer stream not found: ${streamPath}`);
		return;
	}
	const lines = readFileSync(streamPath, 'utf8')
		.split('\n')
		.filter((line) => line.trim());
	let valid = 0;
	let invalid = 0;
	let verify = 0;
	let executions = 0;
	let lookupFailures = 0;
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			const payload =
				parsed.payload && typeof parsed.payload === 'object' && !Array.isArray(parsed.payload)
					? (parsed.payload as Record<string, unknown>)
					: parsed;
			valid++;
			const tool = parsed.toolName ?? parsed.tool ?? payload.toolName ?? payload.tool;
			const commandId = parsed.commandId ?? payload.commandId;
			const isVerify =
				(tool === undefined || tool === 'verify') &&
				(commandId === undefined || commandId === 'verify');
			if (isVerify) {
				verify++;
				const executed = parsed.executed ?? payload.executed;
				if (executed === true) executions++;
				if (parsed.lookupFailed === true || payload.lookupFailed === true) lookupFailures++;
			}
		} catch {
			invalid++;
		}
	}
	console.log(
		`Producer stream: ${streamPath}\n` +
			`Records: ${lines.length} total, ${valid} valid, ${invalid} malformed\n` +
			`Verify records: ${verify}; executions: ${executions}; failed lookups: ${lookupFailures}`,
	);
}

function runAnalyzer(agentDir: string, streamPath: string): number {
	const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
	const result = spawnSync(npm, ['run', 'test:analyze', '--', agentDir, streamPath], {
		cwd: repoRoot,
		stdio: 'inherit',
		env: { ...process.env, BASH_TOOLS_INVOCATIONS_PATH: streamPath },
	});
	if (result.error) {
		console.error(`Unable to run the analyzer: ${result.error.message}`);
		return 1;
	}
	return result.status ?? 1;
}

function requiredOptionValue(argv: string[], index: number, option: string): string {
	const value = argv[index];
	if (!value || value === '--' || value.startsWith('--')) {
		throw new Error(`${option} requires a path value.`);
	}
	return value;
}

function parseArgs(argv: string[]): {
	mode: Mode;
	streamPath: string;
	agentDir: string;
	reset: boolean;
	command: string[];
} {
	let mode: Mode = 'prepare';
	let index = 0;
	if (argv[0] === 'prepare' || argv[0] === 'run' || argv[0] === 'analyze') {
		mode = argv[0];
		index++;
	}
	let streamPath = process.env.BASH_TOOLS_INVOCATIONS_PATH ?? defaultStreamPath;
	let agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
	let reset = false;
	while (index < argv.length && argv[index] !== '--') {
		const argument = argv[index++];
		switch (argument) {
			case '--stream':
				streamPath = requiredOptionValue(argv, index, argument);
				index++;
				break;
			case '--agent-dir':
				agentDir = requiredOptionValue(argv, index, argument);
				index++;
				break;
			case '--reset':
				reset = true;
				break;
			case '--help':
				usage();
				process.exit(0);
			default:
				throw new Error(`Unknown option: ${argument}`);
		}
	}
	if (!streamPath || !agentDir) throw new Error('Stream and agent paths must not be empty.');
	return {
		mode,
		streamPath: resolve(process.cwd(), streamPath),
		agentDir: resolve(process.cwd(), agentDir),
		reset,
		command: argv[index] === '--' ? argv.slice(index + 1) : [],
	};
}

function main(): number {
	let options: ReturnType<typeof parseArgs>;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		usage();
		return 2;
	}

	if (options.mode === 'run' && options.command.length === 0) {
		console.error('run mode requires a command after --, for example: run -- pi');
		return 2;
	}
	if (options.mode !== 'run' && options.command.length > 0) {
		console.error('A command after -- is only valid in run mode.');
		return 2;
	}
	if (options.mode === 'analyze' && options.reset) {
		console.error('--reset is only valid in prepare or run mode.');
		return 2;
	}
	if (options.mode === 'analyze' && !existsSync(options.streamPath)) {
		console.error(`Producer stream not found: ${options.streamPath}`);
		console.error('Run prepare or run mode first, then analyze the existing stream.');
		return 1;
	}

	if (options.mode !== 'analyze') prepareStream(options.streamPath, options.reset);
	if (options.mode === 'prepare') {
		console.log(`Prepared producer stream at ${options.streamPath}`);
		console.log('Launch the producer with this environment:');
		if (process.platform === 'win32') {
			console.log(
				`PowerShell: $env:BASH_TOOLS_INVOCATIONS_PATH = ${shellQuote(options.streamPath)}`,
			);
			console.log(`cmd.exe: set "BASH_TOOLS_INVOCATIONS_PATH=${options.streamPath}"`);
		} else {
			console.log(`export BASH_TOOLS_INVOCATIONS_PATH=${shellQuote(options.streamPath)}`);
		}
		console.log('Then run this script in analyze mode after completing a representative flow:');
		const analyzeCommand = `node analysis/collect-s5-telemetry.ts analyze --agent-dir ${shellQuote(options.agentDir)} --stream ${shellQuote(options.streamPath)}`;
		console.log(analyzeCommand);
		if (process.platform === 'win32') {
			console.log(
				`cmd.exe: node analysis/collect-s5-telemetry.ts analyze --agent-dir "${options.agentDir}" --stream "${options.streamPath}"`,
			);
		}
		return 0;
	}

	let streamWasSummarized = false;
	if (options.mode === 'run') {
		const [command, ...args] = options.command;
		const result = spawnSync(command, args, {
			cwd: repoRoot,
			stdio: 'inherit',
			env: { ...process.env, BASH_TOOLS_INVOCATIONS_PATH: options.streamPath },
		});
		if (result.error) {
			console.error(`Unable to launch ${command}: ${result.error.message}`);
			return 1;
		}
		if (result.status !== 0) {
			console.error(`${command} exited with status ${result.status ?? 'unknown'}.`);
			return result.status ?? 1;
		}
		streamSummary(options.streamPath);
		streamWasSummarized = true;
		if (!existsSync(options.streamPath) || readFileSync(options.streamPath, 'utf8').trim() === '') {
			console.warn(
				'No producer records were written; continuing with extension telemetry fallback. Check the bash-tools stream configuration if producer-side joins are required.',
			);
		}
	}

	if (!streamWasSummarized) streamSummary(options.streamPath);
	return runAnalyzer(options.agentDir, options.streamPath);
}

process.exitCode = main();
