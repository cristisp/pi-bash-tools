type SchemaString = {
  readonly type: string;
  readonly maxLength?: number;
  readonly pattern?: string;
};

type SchemaArray = {
  readonly type: string;
  readonly items: SchemaString;
  readonly maxItems?: number;
};

type SchemaPaths = SchemaArray | { readonly anyOf: readonly SchemaArray[] };

export type SchemaVariant = {
  readonly additionalProperties: boolean;
  readonly properties: {
    readonly commandId: { readonly const?: string; readonly pattern?: string };
    readonly paths?: SchemaPaths;
    readonly grep?: SchemaString;
    readonly projects?: SchemaArray;
  };
  readonly type: string;
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isSchemaCommandId(
  value: unknown,
): value is { readonly const?: string; readonly pattern?: string } {
  return isRecord(value) && (typeof value.const === "string" || typeof value.pattern === "string");
}

function isSchemaArray(value: unknown): value is SchemaArray {
  return (
    isRecord(value) &&
    value.type === "array" &&
    isRecord(value.items) &&
    value.items.type === "string"
  );
}

function isSchemaPaths(value: unknown): value is SchemaPaths | undefined {
  return (
    value === undefined ||
    isSchemaArray(value) ||
    (isRecord(value) && isUnknownArray(value.anyOf) && value.anyOf.some(isSchemaArray))
  );
}

function isSchemaVariant(value: unknown): value is SchemaVariant {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    value.additionalProperties === false &&
    isRecord(value.properties) &&
    isSchemaCommandId(value.properties.commandId) &&
    isSchemaPaths(value.properties.paths)
  );
}

export function schemaVariants(schema: unknown): readonly SchemaVariant[] {
  if (!isRecord(schema) || !isUnknownArray(schema.anyOf)) {
    throw new Error("Project command schema does not contain valid variants");
  }
  const commandVariants = schema.anyOf.filter(isSchemaVariant);
  if (commandVariants.length === 0) {
    throw new Error("Project command schema does not contain command variants");
  }
  return commandVariants;
}
