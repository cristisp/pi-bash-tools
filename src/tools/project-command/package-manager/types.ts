export const supportedPackageManagers = ["npm", "pnpm", "bun", "yarn"] as const;

export type PackageManagerInternal = (typeof supportedPackageManagers)[number];

export type PackageManagerAvailabilityInternal = Readonly<
  Partial<Record<PackageManagerInternal, boolean>>
>;

export type PackageManagerAvailabilityInputInternal =
  | PackageManagerAvailabilityInternal
  | ReadonlySet<PackageManagerInternal>
  | readonly PackageManagerInternal[];

export interface PackageManagerDetectionInputInternal {
  readonly packageManager?: unknown;
  readonly lockfiles: Iterable<string>;
}

export interface DetectedPackageManagerInternal {
  readonly manager: PackageManagerInternal;
  readonly version: string | undefined;
  readonly source: "packageManager" | "lockfile" | "default";
}

export interface PackageManagerFileSystemInternal {
  readonly readFile: (path: string, encoding: "utf8") => Promise<string>;
  readonly stat: (path: string) => Promise<import("node:fs").Stats>;
}

export interface ProjectPackageManagerDetectionOptionsInternal {
  readonly availability?: PackageManagerAvailabilityInputInternal;
  readonly fileSystem?: Pick<PackageManagerFileSystemInternal, "readFile" | "stat">;
}

export interface PackageManagerExecutableResolutionOptionsInternal {
  readonly fileSystem?: Pick<PackageManagerFileSystemInternal, "stat">;
  readonly nodeExecutable?: string;
  readonly approvedDirectories?: readonly string[];
}
