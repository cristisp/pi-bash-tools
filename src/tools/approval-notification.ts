import { execFile } from "node:child_process";

const NOTIFICATION_TITLE = "Pi";
const NOTIFICATION_BODY = "Subagent is waiting for manual policy approval.";

interface NotificationOutput {
  readonly isTTY?: boolean;
  write(message: string): unknown;
}

function windowsToastScript(): string {
  const type = "Windows.UI.Notifications";
  const manager = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
  const template = `[${type}.ToastTemplateType]::ToastText01`;
  const toast = `[${type}.ToastNotification]::new($xml)`;
  return [
    `${manager} > $null`,
    `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
    `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${NOTIFICATION_BODY}')) > $null`,
    `[${type}.ToastNotificationManager]::CreateToastNotifier('${NOTIFICATION_TITLE}').Show(${toast})`,
  ].join("; ");
}

function notifyWindows(): void {
  execFile(
    "powershell.exe",
    ["-NoProfile", "-Command", windowsToastScript()],
    { windowsHide: true },
    () => undefined,
  );
}

function notifyOsc777(output: NotificationOutput): void {
  output.write(`\x1b]777;notify;${NOTIFICATION_TITLE};${NOTIFICATION_BODY}\x07`);
}

function notifyOsc99(output: NotificationOutput): void {
  output.write(`\x1b]99;i=1:d=0;${NOTIFICATION_TITLE}\x1b\\`);
  output.write(`\x1b]99;i=1:p=body;${NOTIFICATION_BODY}\x1b\\`);
}

function terminalOutput(mode: string): NotificationOutput | undefined {
  if (mode === "rpc") {
    return process.stderr.isTTY ? process.stderr : undefined;
  }
  if (process.stdout.isTTY) return process.stdout;
  if (process.stderr.isTTY) return process.stderr;
  return undefined;
}

export function notifySubagentApproval(
  mode: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  output: NotificationOutput | undefined = terminalOutput(mode),
): void {
  if (mode !== "tui" && mode !== "rpc") return;
  try {
    if (environment.WT_SESSION !== undefined) {
      notifyWindows();
      return;
    }
    if (output === undefined || output.isTTY !== true) return;
    if (environment.KITTY_WINDOW_ID !== undefined) {
      notifyOsc99(output);
      return;
    }
    notifyOsc777(output);
  } catch {
    return;
  }
}
