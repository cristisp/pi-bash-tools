export interface ProjectCommandParameterDeclaration {
  readonly name: string;
  readonly kind: "workspace-paths" | "revision";
  readonly required: boolean;
  readonly mapping: "repeated-after-separator" | "flag-value";
}

export type NodeTestParameters = Readonly<{ paths: readonly string[] }>;
