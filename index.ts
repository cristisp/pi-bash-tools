import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
	registerCreatePresetCommand,
	registerKillCommand,
	registerPresetStatus,
	registerSelectPresetCommand,
	registerSetupCommand,
} from './src/commands.ts';
import { registerBudgetEnforcement } from './src/budget.ts';
import { deriveFlowId, ENV_FLOW } from './src/delegation.ts';
import { HERDR_ENV, HERDR_PANE_ID, HERDR_SOCKET_PATH, NESTED } from './src/herdr.ts';
import { pruneFlows } from './src/flow.ts';
import { registerInputHandler } from './src/input.ts';
import { reconcileRegistry } from './src/registry.ts';
import { registerUiPromptMarker } from './src/ui-prompt-marker.ts';
import { registerUiPromptReporter } from './src/ui-prompt-report.ts';
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
		pi.on('session_start', (_event, ctx) => {
			reconcileRegistry().catch(() => {});
			try {
				pruneFlows();
			} catch {}
			try {
				const flowId = deriveFlowId(ctx.sessionManager.getSessionFile());
				if (flowId) process.env[ENV_FLOW] = flowId;
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
	registerUiPromptMarker(pi);
	registerUiPromptReporter(pi);
}
