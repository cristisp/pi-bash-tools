export interface MeasurementPair {
  readonly before: number;
  readonly after: number;
}

export function measurementPair(before: number, after: number): MeasurementPair {
  return Object.freeze({
    before: Number.isFinite(before) && before >= 0 ? before : 0,
    after: Number.isFinite(after) && after >= 0 ? after : 0,
  });
}
