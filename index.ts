import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
	registerCreatePresetCommand,
	registerKillCommand,
	registerPresetStatus,
	registerSelectPresetCommand,
	registerSetupCommand,
} from './src/commands.ts';
import { registerBudgetEnforcement } from './src/budget.ts';
import { HERDR_ENV, HERDR_PANE_ID, HERDR_SOCKET_PATH, NESTED } from './src/herdr.ts';
import { pruneFlows } from './src/flow.ts';
import { registerInputHandler } from './src/input.ts';
import { reconcileRegistry } from './src/registry.ts';
import {
	registerSubagentCloseTool,
	registerSubagentOverrideTool,
	registerSubagentStatsTool,
	registerSubagentTool,
} from './src/tools.ts';

function hasHerdrEnv(): boolean {
	return HERDR_ENV && !!HERDR_SOCKET_PATH && !!HERDR_PANE_ID;
}

export default function (pi: ExtensionAPI) {
	if (!hasHerdrEnv()) return;
	if (NESTED) registerBudgetEnforcement(pi);
	if (!NESTED) {
		reconcileRegistry().catch(() => {});
		pi.on('session_start', () => {
			reconcileRegistry().catch(() => {});
			try {
				pruneFlows();
			} catch {}
		});
		registerSubagentCloseTool(pi);
		registerSetupCommand(pi);
		registerSelectPresetCommand(pi);
		registerCreatePresetCommand(pi);
		registerKillCommand(pi);
		registerPresetStatus(pi);
	}

	registerSubagentTool(pi);
	registerSubagentOverrideTool(pi);
	registerSubagentStatsTool(pi);
	registerInputHandler(pi);
}
