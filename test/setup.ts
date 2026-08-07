import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-herdr-run-'));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.HERDR_PANE_ID = 'ws1:p1';
process.env.HERDR_SESSION = 'ws1';
