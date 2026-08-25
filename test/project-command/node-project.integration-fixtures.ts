import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface NodeProjectIntegrationFixture {
  readonly directory: string;
  readonly projectPath: string;
  readonly cleanup: () => Promise<void>;
}

const fixtureManifest = {
  name: "bash-tools-fixture",
  version: "1.0.0",
  packageManager: "npm@10.0.0",
  scripts: {
    test: "node fixture-runner.js test",
    "test:coverage": "node fixture-runner.js test:coverage",
    "test:e2e": "node fixture-runner.js e2e",
    build: "node fixture-runner.js build",
    lint: "node fixture-runner.js lint",
    "lint:fix": "node lint-fix-fixture.js",
    typecheck: "node fixture-runner.js typecheck",
    "format:check": "node fixture-runner.js format:check",
    format: "node format-fixture.js",
  },
};

async function writePackageFixture(directory: string): Promise<void> {
  await writeFile(join(directory, "package.json"), JSON.stringify(fixtureManifest));
  await writeFile(
    join(directory, "fixture-runner.js"),
    'process.stdout.write(`${process.argv[2]}:${process.argv[3] || "none"}\\n`);\n',
  );
}

async function writeMutationFixtures(directory: string): Promise<void> {
  await writeFile(join(directory, "format-target.txt"), "before\n");
  await writeFile(join(directory, "lint-fix-target.txt"), "before\n");
  await writeFile(
    join(directory, "format-fixture.js"),
    [
      'const { readFileSync, writeFileSync } = require("node:fs");',
      'const target = "format-target.txt";',
      'const source = readFileSync(target, "utf8");',
      'writeFileSync(target, source.replace("before", "after"));',
      'process.stdout.write("format:write\\n");',
      "",
    ].join("\n"),
  );
  await writeFile(
    join(directory, "lint-fix-fixture.js"),
    [
      'const { writeFileSync } = require("node:fs");',
      'writeFileSync("lint-fix-target.txt", "after\\n");',
      'process.stdout.write("lint:fix\\n");',
      "",
    ].join("\n"),
  );
}

async function writeFallowFixture(directory: string): Promise<void> {
  const fallowTarget = join(directory, "node_modules", "fallow", "bin", "fallow.js");
  await writeFile(
    fallowTarget,
    [
      'const command = process.argv[2] || "unknown";',
      'process.stdout.write(JSON.stringify({ command, args: process.argv.slice(3) }) + "\\n");',
      'if (command === "audit") process.exitCode = 1;',
      "",
    ].join("\n"),
  );
  await chmod(fallowTarget, 0o755);
  await symlink("../fallow/bin/fallow.js", join(directory, "node_modules", ".bin", "fallow"));
}

async function createFixtureNodeModules(directory: string): Promise<void> {
  await mkdir(join(directory, "node_modules", ".bin"), { recursive: true });
  await mkdir(join(directory, "node_modules", "fallow", "bin"), { recursive: true });
  await writeFallowFixture(directory);
}

export async function createNodeProjectIntegrationFixture(): Promise<NodeProjectIntegrationFixture> {
  const directory = await mkdtemp(join(tmpdir(), "bash-tools-node-project-integration-"));
  const projectPath = await realpath(directory);
  await writePackageFixture(directory);
  await writeMutationFixtures(directory);
  await createFixtureNodeModules(directory);
  let cleaned = false;
  return {
    directory,
    projectPath,
    cleanup: async () => {
      if (!cleaned) {
        cleaned = true;
        await rm(directory, { force: true, recursive: true });
      }
    },
  };
}
