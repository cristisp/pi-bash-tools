import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerKillCommand, registerSetupCommand } from './src/commands.ts';
import { HERDR_ENV, HERDR_PANE_ID, HERDR_SOCKET_PATH, NESTED } from './src/herdr.ts';
import { registerInputHandler } from './src/input.ts';
import { reconcileRegistry } from './src/registry.ts';
import {
	registerSubagentCloseTool,
	registerSubagentStatsTool,
	registerSubagentTool,
} from './src/tools.ts';

function hasHerdrEnv(): boolean {
	return HERDR_ENV && !!HERDR_SOCKET_PATH && !!HERDR_PANE_ID;
}

export default function (pi: ExtensionAPI) {
	if (!hasHerdrEnv()) return;
	if (!NESTED) {
		reconcileRegistry().catch(() => {});
		pi.on('session_start', () => {
			reconcileRegistry().catch(() => {});
		});
		registerSubagentCloseTool(pi);
		registerSetupCommand(pi);
		registerKillCommand(pi);
	}

	registerSubagentTool(pi);
	registerSubagentStatsTool(pi);
	registerInputHandler(pi);
}
