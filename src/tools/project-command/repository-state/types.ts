export interface ProjectCommandRepositoryState {
  readonly repositoryIdentity: string;
  readonly head: string;
  readonly dirtyFilesDigest: string;
}

export type ProjectCommandRepositoryStateReader = (
  projectPath: string,
  signal: AbortSignal | undefined,
) => Promise<ProjectCommandRepositoryState | undefined>;
