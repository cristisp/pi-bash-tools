import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerKillCommand, registerSetupCommand } from './src/commands.ts';
import { HERDR_ENV, HERDR_PANE_ID, HERDR_SOCKET_PATH, NESTED } from './src/herdr.ts';
import { registerInputHandler } from './src/input.ts';
import { reconcileRegistry } from './src/registry.ts';
import { registerSubagentCloseTool, registerSubagentTool } from './src/tools.ts';

export default function (pi: ExtensionAPI) {
	if (!HERDR_ENV || !HERDR_SOCKET_PATH || !HERDR_PANE_ID) return;
	if (!NESTED) {
		reconcileRegistry().catch(() => {});
		pi.on('session_start', () => {
			reconcileRegistry().catch(() => {});
		});
	}

	registerSubagentTool(pi);
	if (!NESTED) {
		registerSubagentCloseTool(pi);
		registerSetupCommand(pi);
		registerKillCommand(pi);
	}
	registerInputHandler(pi);
}
