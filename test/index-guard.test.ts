import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "./helpers.ts";

function mockPi() {
	return {
		on: vi.fn(),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
	};
}

beforeEach(() => {
	vi.resetModules();
	vi.stubEnv("HERDR_ENV", "");
	vi.stubEnv("HERDR_SOCKET_PATH", "");
	vi.stubEnv("HERDR_PANE_ID", "");
	vi.stubEnv("PI_CODING_AGENT_DIR", makeTempDir());
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("extension registration guard", () => {
	it("registers nothing when herdr env is missing", async () => {
		const { default: register } = await import("../index.ts");
		const pi = mockPi();
		register(pi as never);
		expect(pi.registerTool).not.toHaveBeenCalled();
		expect(pi.registerCommand).not.toHaveBeenCalled();
		expect(pi.on).not.toHaveBeenCalled();
	});
});
