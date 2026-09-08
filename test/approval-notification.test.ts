import { expect, it, vi } from "vitest";

import { notifySubagentApproval } from "../src/tools/approval-notification.ts";

function output() {
  return { isTTY: true, write: vi.fn() };
}

it("sends an OSC 777 notification in the TUI", () => {
  const terminal = output();
  notifySubagentApproval("tui", {}, terminal);
  expect(terminal.write).toHaveBeenCalledWith(
    "\x1b]777;notify;Pi;Subagent is waiting for manual policy approval.\x07",
  );
});

it("uses the Kitty notification protocol when Kitty is active", () => {
  const terminal = output();
  notifySubagentApproval("tui", { KITTY_WINDOW_ID: "1" }, terminal);
  expect(terminal.write).toHaveBeenNthCalledWith(1, "\x1b]99;i=1:d=0;Pi\x1b\\");
  expect(terminal.write).toHaveBeenNthCalledWith(
    2,
    "\x1b]99;i=1:p=body;Subagent is waiting for manual policy approval.\x1b\\",
  );
});

it("uses only a TTY for terminal escape sequences", () => {
  const terminal = { isTTY: false, write: vi.fn() };
  const rpcTerminal = output();
  notifySubagentApproval("tui", {}, terminal);
  notifySubagentApproval("rpc", {}, rpcTerminal);
  expect(terminal.write).not.toHaveBeenCalled();
  expect(rpcTerminal.write).toHaveBeenCalledOnce();
});
