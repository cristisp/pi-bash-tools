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

export type SchemaVariant = {
  readonly additionalProperties: boolean;
  readonly properties: {
    readonly commandId: { readonly const: string };
    readonly paths?: SchemaArray;
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

function isSchemaCommandId(value: unknown): value is { readonly const: string } {
  return isRecord(value) && typeof value.const === "string";
}

function isSchemaPaths(value: unknown): value is SchemaArray | undefined {
  return (
    value === undefined ||
    (isRecord(value) &&
      value.type === "array" &&
      isRecord(value.items) &&
      value.items.type === "string")
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
  if (!isRecord(schema) || !isUnknownArray(schema.anyOf) || !schema.anyOf.every(isSchemaVariant)) {
    throw new Error("Project command schema does not contain valid variants");
  }
  return schema.anyOf.filter(isSchemaVariant);
}
