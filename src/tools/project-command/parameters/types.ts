export interface ProjectCommandParameterDeclaration {
  readonly name: string;
  readonly kind:
    | "workspace-paths"
    | "revision"
    | "text"
    | "text-list"
    | "positive-integer"
    | "non-negative-integer"
    | "boolean"
    | "script-variant";
  readonly required: boolean;
  readonly mapping:
    | "repeated-after-separator"
    | "flag-value"
    | "repeated-flag-value"
    | "flag"
    | "package-script-suffix";
}

export type NodeTestParameters = Readonly<{ paths: readonly string[] }>;
