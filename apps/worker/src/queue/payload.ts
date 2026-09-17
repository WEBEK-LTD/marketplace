/** Queue jobs carry IDs only: a flat object of `<name>Id` keys with UUID values. */
export type IdPayload = Readonly<Record<`${string}Id`, string>>;

const KEY_PATTERN = /^[a-z][A-Za-z0-9]*Id$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidJobPayloadError extends TypeError {
  constructor() {
    super('Job data must contain only <name>Id keys with UUID values.');
    this.name = 'InvalidJobPayloadError';
  }
}

export function assertIdPayload(value: unknown): asserts value is IdPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidJobPayloadError();
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new InvalidJobPayloadError();
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new InvalidJobPayloadError();
  }
  for (const [key, id] of entries) {
    if (!KEY_PATTERN.test(key) || typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      throw new InvalidJobPayloadError();
    }
  }
}
