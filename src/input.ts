import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getAgentStatus } from './herdr.ts';
import { readRegistry } from './registry-store.ts';

export function registerInputHandler(pi: ExtensionAPI) {
	pi.on('input', async (event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;
		const reg = readRegistry();
		for (const entry of Object.values(reg.tabs)) {
			if (entry.sessionFile !== sessionFile || entry.status === 'running') continue;
			const { status } = await getAgentStatus(entry.paneId);
			if (status === 'working' || status === 'blocked') {
				return { action: 'continue' };
			}
			ctx.ui.notify(
				`Subagent session ${entry.label} is read-only (its result was delivered). Reuse it via the subagent tool to make it interactive again.`,
				'warning',
			);
			return { action: 'handled' };
		}
		return { action: 'continue' };
	});
}
