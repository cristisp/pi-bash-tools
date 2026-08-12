import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-herdr-run-'));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.HERDR_ENV = '1';
process.env.HERDR_SOCKET_PATH = path.join(dir, 'herdr.sock');
process.env.HERDR_PANE_ID = 'ws1:p1';
process.env.HERDR_WORKSPACE_ID = 'ws1';
process.env.HERDR_SESSION = 'ws1';
process.env.PI_SUBAGENT_NESTED = '0';
