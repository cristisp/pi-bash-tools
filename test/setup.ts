import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-herdr-run-'));

/*
 * Each test file runs in its own vitest worker, and production code creates prompt directories with
 * `mkdtemp(join(tmpdir(), 'pi-subagent-'))`. Pointing TMPDIR at a per-file private root means those
 * directories cannot be seen by, or collide with, sibling test files or real subagent launches from
 * other sessions on the machine.
 */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-herdr-tmp-'));
process.env.TMPDIR = scratch;

process.env.PI_CODING_AGENT_DIR = dir;
process.env.HERDR_ENV = '1';
process.env.HERDR_SOCKET_PATH = path.join(dir, 'herdr.sock');
process.env.HERDR_PANE_ID = 'ws1:p1';
process.env.HERDR_WORKSPACE_ID = 'ws1';
process.env.HERDR_SESSION = 'ws1';
process.env.PI_SUBAGENT_NESTED = '0';

afterAll(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
});
