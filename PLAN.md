# PLAN - subagent-herdr improvements

## Task 1: Close-subagents tool + user command

### Status: implemented, decisions resolved

Decisions: session-linked only (no workspace sweep - a workspace can house multiple main sessions); always confirm, with a warning when any target is still running; session files always preserved; agent tool has `all` (default) and `label` options, user command `/kill-session-subagents` closes all.

### Goal

Give the user a way to close all subagents linked to the active session: list them, close their herdr tabs, and remove them from the registry.

Two entry points, sharing one implementation:

- A `subagent`-style tool the agent can call - but only when the user explicitly asks for it (enforced via the tool description, never autonomous).
- A user slash command (e.g. `/subagent-close`) via `pi.registerCommand` - commands are checked before the `input` event, so this runs directly without involving the agent.

### What already exists

- `closeTab(tabId)` (`index.ts` ~line 288) - wraps `herdrCli(["tab", "close", tabId])`, already used for cleanup on failed spawns.
- `removeRegistryEntry(label)` (~line 212) - deletes an entry from the registry.
- `ownWorkspaceId()` (~line 67) - the workspace from `HERDR_PANE_ID`; all subagents spawn into it.
- `readRegistry()` / `mutateRegistry()` - safe locked registry access.
- `reconcileRegistry()` already prunes entries whose tabs vanished, so closing a tab + removing the entry explicitly is the consistent cleanup path.

### Registry schema addition

- Entries do not currently record which main session spawned them (they are only workspace-scoped), so "linked to the active session" cannot be determined precisely.
- Add `parentSession?: string` to `RegistryEntry`, set at `registerEntry` time from `ctx.sessionManager.getSessionFile()` (the spawning session's file).
- The close logic filters entries by `parentSession === current session file`; entries without the field (pre-upgrade) fall back to workspace scope.
- Old registry JSON stays backward-compatible: `readRegistry` tolerates missing fields.

### Implementation sketch

- Extract a shared `closeLinkedSubagents()` helper: read registry, filter to linked entries (session-linked, falling back to workspace), build a list (label, agent, pane, status, ctx size if present), close each tab via `closeTab`, remove each entry via `removeRegistryEntry`, return the list of what was closed.
- Tool path: `pi.registerTool` (name e.g. `subagent_close`, label "Close Subagents") with empty parameters; description states it may only be used when the user explicitly requests closing subagents; returns the closed list as content.
- Command path: `pi.registerCommand("subagent-close", ...)` with the same helper; notify via `ctx.ui.notify` and/or `ctx.ui.confirm` before closing.
- Guard with a confirmation when the UI is available (`ctx.hasUI`): show the list and confirm before closing, especially when any entry is still `running` (closing kills in-flight work).

### Open questions

- Confirm-before-close: always, and the confirm text flags entries that are still `running` (closing them kills in-flight work) - decided.
- Session files: always preserved; only the registry entries and herdr tabs are removed - decided.
- Scope: strictly session-linked via `parentSession`; entries from other main sessions in the same workspace are never touched - decided.
- Agent tool accepts `label` (close one session-linked subagent) or nothing (close all session-linked); the user command takes no arguments and always closes all - decided.

## Task 3: /setup-subagents command (agent bootstrap)

### Status: implemented

The four standard agents (planner, reviewer, scout, worker) are not shipped with the package, so a `/setup-subagents` command scaffolds them into `~/.pi/agent/agents`. Templates live in `templates.ts` (derived from the canonical agent files); the command asks for the model as `provider/model(:thinking_level)` (validates the pattern, normalizes the level to lowercase, re-prompts up to 3 times), confirms before overwriting existing files, and reports created/updated counts.

## Task 2: Show subagent status (especially approval-waiting) in the main session summary

### Status: implemented and verified end-to-end, decisions resolved

Verification (live, workspace w8): a worker subagent ran `rm -rf /tmp/agent-space/subagent-herdr-e2e`, arx showed its confirm prompt in the subagent tab, herdr reported `blocked`, and the main session showed the live line `blocked - awaiting approval: bash rm -rf /tmp/agent-space/subagent-herdr-e2e, since 19:57 (approve/reject in tab w8:worker-4)` plus a `ui.notify` toast. After the user approved in the tab, the subagent unblocked and completed with a clean result (blocked fields cleared from the registry; entry `done` with contextTokens/parentSession).

Decisions: herdr 0.7.5 does not expose the block reason (its AgentStatus enum is only idle/working/blocked/done/unknown, and neither `herdr agent get` nor the pane_agent_status_changed event carries a reason) - so the reason is sniffed from the session tail in `pollSubagent` (an assistant toolCall without a matching toolResult = approval-waiting; anything else = steer/needs input). A `ui.notify` is pushed when a subagent first blocks on approval. Chain-mode blocked steps render as paused (⏸) rather than failed.

### Problem

When a subagent needs to run a command that requires arx approval (it waits for approve/reject in its tab), the main agent currently only learns about it by watching herdr's per-tab UI or manually checking each session.

The main session's subagent tool summary is where the user wants to see this.

### What already exists

- The extension polls the herdr agent status during a run via `getAgentStatus` (`index.ts` ~line 273) - statuses: `working`, `idle`, `blocked`, `done`, `unknown`, `no-agent`, `gone`.
- A blocked subagent already surfaces in two places:
  - Live updates during the run: `emitStatusUpdate` (`index.ts` ~line 576) emits `[blocked - needs input]` as the tool call content tag.
  - Final result renderer: single mode shows `blocked - needs input (steer in its tab)` (`index.ts` ~line 1531); parallel mode shows a `⚠` icon and `blocked - needs input` (`index.ts` ~line 1710-1724).
- `reconcileRegistry` deliberately leaves blocked sessions `running` (it only flips idle/done/no-agent entries to `done`), so a blocked subagent stays reusable/steerable after the main run ends.

### Gaps

- The summary says "blocked - needs input" without saying why: awaiting an arx approval vs. awaiting a steer vs. something else.
- It does not show what the subagent is waiting on (e.g. the pending command that requires approval).
- For parallel runs, the blocked state per subagent is only visible in the collapsed icon and a short text line; the user still has to open the tab to act.
- There is no "blocked since <time>" info, so after the run ends it is unclear how long a subagent has been waiting.

### Proposed change

- Investigate how herdr reports an approval-waiting agent: does `herdr agent get` distinguish approval-waiting from steer-waiting, or expose the pending request (e.g. a pending tool call / approval record)? Check herdr 0.7.5 API surface first - this determines how much detail is available.
- If herdr does not distinguish: detect approval-waiting from the session tail in `pollSubagent` (scan for the arx approval prompt text or a tool call that awaits approval) and set a reason on `SingleResult`, e.g. `herdrStatus: "blocked"` + `blockReason: "approval" | "steer"` with a short preview of the pending command.
- Surface the reason in the summary:
  - Live updates: `[blocked - awaiting approval]` plus the pending command preview in the emitted text.
  - Final renderer (single + parallel + chain): replace the generic "blocked - needs input" line with the reason and the pending command preview, e.g. `⚠ blocked - awaiting approval: bash rm -rf /tmp/x (approve in tab wB:worker-1)`.
- Record a `blockedSince` timestamp in the registry entry (via `updateRegistryEntry`) so `listSubagents` and the summary can show `blocked since 12:04` even after the run that spawned it has ended.
- Keep the existing input-guard behavior: steering into a blocked session stays allowed (the `input` event handler at `index.ts` ~line 1748 already lets `working`/`blocked` sessions accept input).

### Open questions

- Whether the pending-command preview is available from herdr's API or must be sniffed from the session file tail - resolved: herdr's API does not expose it (checked 0.7.5 AgentInfo schema and pane_agent_status_changed event schema in the binary); the preview is extracted from the pending tool call's arguments in the session tail.
- Whether the approval state should also be pushed as a notification (pi `ui.notify`) when a subagent first blocks - resolved: yes, notified once per approval block (with the pending command preview); steer blocks are not notified (the user steered them deliberately).
- Whether chain-mode steps should show a blocked step as "paused" rather than failed (currently an aborted chain step is reported as an error) - resolved: renderers show a blocked step as ⏸ paused with the reason; abort semantics unchanged.

### Implementation notes (what was built)

- `SingleResult` and `RegistryEntry` gain `blockReason` ("approval" | "steer"), `blockedSince`, and `blockedPreview`.
- `pollSubagent` tracks unresolved tool call ids from the session tail; on entering `blocked` it classifies approval vs steer, stamps `blockedSince`, persists all three fields via `updateRegistryEntry`, and fires an `onBlocked` callback (wired to `ctx.ui.notify` in the tool execute path). The registry is cleared again when the subagent unblocks, and `completionPatch` clears the fields on completion.
- Live updates: `[blocked - awaiting approval: bash <cmd>]` / `[blocked - needs input]` tags via `statusTag`.
- Final renderers (single, parallel, chain): blocked lines become `blocked - awaiting approval: <preview>, since <HH:MM> (approve/reject in tab <ws>:<label>)` (warning color); chain steps show ⏸ instead of ✗ and the chain aggregate shows ⏸ when blocked without failures.
- `listSubagents` and the `/kill-session-subagents` confirmation show `blocked since <HH:MM> (<reason>)` for running entries.
- Backward compatible: all new registry fields optional; `readRegistry` tolerates missing fields.
