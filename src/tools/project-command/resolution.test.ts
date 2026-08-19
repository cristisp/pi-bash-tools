import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectPackageManager,
  detectPackageManagerDetails,
  detectProjectPackageManager,
  isProjectCommandResolutionError,
  ProjectCommandResolutionError,
  resolveFixedProjectCommand,
  resolveProjectBinary,
  type PackageManager,
  type PackageManagerAvailability,
} from "./resolution.ts";
import { getProjectCommandDefinition, projectCommandIdentity } from "./definitions.ts";

const directories: string[] = [];
const available: PackageManagerAvailability = {
  npm: true,
  pnpm: true,
  bun: true,
  yarn: true,
};

function expectResolutionError(
  operation: Promise<unknown>,
  stage: string,
  code: string,
): Promise<void> {
  return expect(operation).rejects.toMatchObject({
    name: "ProjectCommandResolutionError",
    stage,
    code,
    details: { stage, code },
  });
}

async function projectDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bash-tools-project-command-resolution-"));
  directories.push(directory);
  return directory;
}

async function createBinaryProject(): Promise<{
  directory: string;
  nodeModules: string;
  binDirectory: string;
}> {
  const directory = await projectDirectory();
  const nodeModules = join(directory, "node_modules");
  const binDirectory = join(nodeModules, ".bin");
  await mkdir(binDirectory, { recursive: true });
  return { directory, nodeModules, binDirectory };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("project command resolution", () => {
  it("exposes stable stage errors without raw error details", async () => {
    const error = new ProjectCommandResolutionError("detection", "invalid-package-manager", {
      manager: "npm",
    });
    expect(isProjectCommandResolutionError(error)).toBe(true);
    expect(error.stage).toBe("detection");
    expect(error.code).toBe("invalid-package-manager");
    expect(error.details).toEqual({
      stage: "detection",
      code: "invalid-package-manager",
      manager: "npm",
    });

    const directory = await projectDirectory();
    await writeFile(join(directory, "package.json"), "not-json: secret manifest");
    await expectResolutionError(
      detectProjectPackageManager(directory, { availability: available }),
      "detection",
      "invalid-package-manifest",
    );
    await expect(
      detectProjectPackageManager(directory, { availability: available }),
    ).rejects.not.toMatchObject({ details: expect.stringContaining("secret") });
    expect(JSON.stringify(error)).not.toContain("secret");
  });

  it("resolves fixed commands without changing executable, arguments, or identity", async () => {
    const definition = getProjectCommandDefinition("node_version");
    if (definition === undefined) {
      throw new Error("missing node_version definition");
    }
    const resolved = resolveFixedProjectCommand(definition);
    expect(resolved).toEqual({
      definition,
      executable: process.execPath,
      args: ["--version"],
    });
    expect(resolved.executable).toBe(definition.executable);
    expect(resolved.args).toBe(definition.args);
    expect(projectCommandIdentity(definition, resolved)).toEqual(
      projectCommandIdentity(definition),
    );
  });

  it("applies explicit package manager precedence and strict availability", () => {
    expect(
      detectPackageManager(
        { packageManager: "pnpm@9.1.0", lockfiles: ["package-lock.json", "pnpm-lock.yaml"] },
        available,
      ),
    ).toBe("pnpm");
    expect(() =>
      detectPackageManager({ packageManager: "npm@^10.0.0", lockfiles: [] }, available),
    ).toThrowError(
      expect.objectContaining({ stage: "detection", code: "invalid-package-manager" }),
    );
    expect(() =>
      detectPackageManager({ packageManager: "deno@1.0.0", lockfiles: [] }, available),
    ).toThrowError(
      expect.objectContaining({ stage: "detection", code: "invalid-package-manager" }),
    );
    expect(() =>
      detectPackageManager({ packageManager: "bun@1.0.0", lockfiles: [] }, { npm: true }),
    ).toThrowError(
      expect.objectContaining({ stage: "detection", code: "package-manager-unavailable" }),
    );
  });

  it("accepts supported exact versions and rejects malformed explicit values", () => {
    const validVersions = [
      { packageManager: "npm@0.0.0", manager: "npm", version: "0.0.0" },
      { packageManager: "pnpm@1.2.3-0", manager: "pnpm", version: "1.2.3-0" },
      {
        packageManager: "bun@10.20.30-rc.1+build.7",
        manager: "bun",
        version: "10.20.30-rc.1+build.7",
      },
      {
        packageManager: "yarn@1.2.3-alpha.1+build.01",
        manager: "yarn",
        version: "1.2.3-alpha.1+build.01",
      },
    ] as const;
    for (const valid of validVersions) {
      expect(
        detectPackageManagerDetails(
          { packageManager: valid.packageManager, lockfiles: [] },
          available,
        ),
      ).toEqual({ manager: valid.manager, version: valid.version, source: "packageManager" });
    }

    const malformedVersions = [
      ...["\n", "\r", "\r\n", "\u2028", "\u2029"].map(
        (lineTerminator) => `npm@1.2.3${lineTerminator}`,
      ),
      "npm@1.2.3-01",
      "pnpm@1.2.3-rc.01",
      "bun@1.2.3-1.0.01",
    ];
    for (const packageManager of malformedVersions) {
      expect(() => detectPackageManager({ packageManager, lockfiles: [] }, available)).toThrowError(
        expect.objectContaining({ stage: "detection", code: "invalid-package-manager" }),
      );
    }
  });

  it("detects supported lockfiles, defaults away from Yarn, and rejects conflicts", () => {
    expect(detectPackageManager({ lockfiles: ["package-lock.json"] }, available)).toBe("npm");
    expect(detectPackageManager({ lockfiles: ["npm-shrinkwrap.json"] }, available)).toBe("npm");
    expect(detectPackageManager({ lockfiles: ["pnpm-lock.yaml"] }, available)).toBe("pnpm");
    expect(detectPackageManager({ lockfiles: ["bun.lock"] }, available)).toBe("bun");
    expect(detectPackageManager({ lockfiles: ["bun.lockb"] }, available)).toBe("bun");
    expect(() => detectPackageManager({ lockfiles: ["yarn.lock"] }, available)).toThrowError(
      expect.objectContaining({ stage: "detection", code: "ambiguous-yarn-lockfile" }),
    );
    expect(detectPackageManager({ lockfiles: [] }, available)).toBe("npm");
    expect(() =>
      detectPackageManager({ lockfiles: ["package-lock.json", "pnpm-lock.yaml"] }, available),
    ).toThrowError(expect.objectContaining({ stage: "detection", code: "conflicting-lockfiles" }));
    expect(() =>
      detectPackageManager({ lockfiles: ["pnpm-lock.yaml", "bun.lock"] }, available),
    ).toThrowError(expect.objectContaining({ stage: "detection", code: "conflicting-lockfiles" }));
    expect(() => detectPackageManager({ lockfiles: [] }, { npm: false })).toThrowError(
      expect.objectContaining({ stage: "detection", code: "package-manager-unavailable" }),
    );
  });

  it("returns source and exact version details from pure detection", () => {
    expect(
      detectPackageManagerDetails(
        { packageManager: "npm@10.2.3", lockfiles: ["yarn.lock"] },
        available,
      ),
    ).toEqual({ manager: "npm", version: "10.2.3", source: "packageManager" });
    expect(detectPackageManagerDetails({ lockfiles: ["pnpm-lock.yaml"] }, available)).toEqual({
      manager: "pnpm",
      version: undefined,
      source: "lockfile",
    });
  });

  it("reads package.json and supported lockfiles without consulting PATH", async () => {
    const directory = await projectDirectory();
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ packageManager: "yarn@4.2.0" }),
    );
    await writeFile(join(directory, "yarn.lock"), "ignored by explicit packageManager");
    await expect(
      detectProjectPackageManager(directory, {
        availability: { npm: true, pnpm: true, bun: true, yarn: false },
      }),
    ).rejects.toMatchObject({ stage: "detection", code: "package-manager-unavailable" });

    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "fixture" }));
    await rm(join(directory, "yarn.lock"));
    await writeFile(join(directory, "package-lock.json"), "{}");
    expect(
      await detectProjectPackageManager(directory, {
        availability: { npm: true, pnpm: false, bun: false, yarn: false },
      }),
    ).toBe("npm");
    expect(await readFile(join(directory, "package.json"), "utf8")).toContain("fixture");
  });

  it("defaults empty project detection options to npm and preserves unavailable checks", async () => {
    const directory = await projectDirectory();
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "fixture" }));

    expect(await detectProjectPackageManager(directory, {})).toBe("npm");
    await expectResolutionError(
      detectProjectPackageManager(directory, new Set<PackageManager>()),
      "detection",
      "package-manager-unavailable",
    );
    await expectResolutionError(
      detectProjectPackageManager(directory, { npm: false }),
      "detection",
      "package-manager-unavailable",
    );
  });

  it("resolves a regular binary and an in-root symlink to its realpath", async () => {
    const { directory, nodeModules, binDirectory } = await createBinaryProject();
    const packageBinary = join(nodeModules, "package", "bin", "tool");
    await mkdir(join(nodeModules, "package", "bin"), { recursive: true });
    await writeFile(packageBinary, "#!/bin/sh\nprintf tool\n");
    const direct = join(binDirectory, "direct");
    await writeFile(direct, "regular");
    expect(await resolveProjectBinary(directory, "direct")).toBe(await realpath(direct));
    const linked = join(binDirectory, "tool");
    await symlink("../package/bin/tool", linked);
    expect(await resolveProjectBinary(directory, "tool")).toBe(await realpath(packageBinary));
  });

  it("fails closed for missing, dangling, escaping, and non-file binaries", async () => {
    const { directory, binDirectory } = await createBinaryProject();
    await expectResolutionError(
      resolveProjectBinary(directory, "missing"),
      "binary-resolution",
      "missing-binary",
    );
    await symlink("../missing/tool", join(binDirectory, "dangling"));
    await expectResolutionError(
      resolveProjectBinary(directory, "dangling"),
      "binary-resolution",
      "dangling-binary",
    );

    const outside = await projectDirectory();
    const outsideBinary = join(outside, "outside");
    await writeFile(outsideBinary, "outside");
    await symlink(outsideBinary, join(binDirectory, "escaping"));
    await expectResolutionError(
      resolveProjectBinary(directory, "escaping"),
      "binary-resolution",
      "binary-target-escape",
    );

    await mkdir(join(binDirectory, "directory"));
    await expectResolutionError(
      resolveProjectBinary(directory, "directory"),
      "binary-resolution",
      "binary-not-file",
    );
  });

  it("rejects a node_modules root escape and invalid names without PATH or npx lookup", async () => {
    const directory = await projectDirectory();
    const outside = await projectDirectory();
    await mkdir(join(outside, ".bin"), { recursive: true });
    await writeFile(join(outside, ".bin", "tool"), "outside");
    await symlink(outside, join(directory, "node_modules"));
    await expectResolutionError(
      resolveProjectBinary(directory, "tool"),
      "binary-resolution",
      "node-modules-root-escape",
    );

    const binaryProject = await createBinaryProject();
    for (const name of ["", "../tool", "tool/name", "/bin/sh", "..", ".", "tool\0name"]) {
      // eslint-disable-next-line no-await-in-loop
      await expectResolutionError(
        resolveProjectBinary(binaryProject.directory, name),
        "binary-resolution",
        "invalid-binary-name",
      );
    }
    await expectResolutionError(
      resolveProjectBinary(binaryProject.directory, "sh"),
      "binary-resolution",
      "missing-binary",
    );
  });
});
