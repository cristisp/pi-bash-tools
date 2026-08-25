export interface ProjectCommandParameterDeclaration {
  readonly name: string;
  readonly kind:
    | "workspace-paths"
    | "revision"
    | "text"
    | "text-list"
    | "positive-integer"
    | "non-negative-integer"
    | "boolean";
  readonly required: boolean;
  readonly mapping: "repeated-after-separator" | "flag-value" | "repeated-flag-value" | "flag";
}

export type NodeTestParameters = Readonly<{ paths: readonly string[] }>;

export interface NodeE2EParameters {
  readonly paths: readonly string[];
  readonly grep?: string;
  readonly projects?: readonly string[];
  readonly workers?: number;
  readonly retries?: number;
  readonly headed?: boolean;
  readonly list?: boolean;
}
