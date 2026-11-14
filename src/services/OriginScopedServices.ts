import type { ApiUsageOrigin } from "places-shared/services";

const MAX_ENTRIES = 64;

export class OriginScopedServices<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly build: (providerName: string, origin: ApiUsageOrigin | undefined) => T | undefined) {}

  get(providerName: string, origin?: ApiUsageOrigin): T | undefined {
    const key = `${providerName}\u0000${origin?.sourcePath ?? ''}\u0000${origin?.blockType ?? ''}`;

    const existing = this.entries.get(key);

    if (existing !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, existing);

      return existing;
    }

    const built = this.build(providerName, origin);

    if (built === undefined) return undefined;

    this.entries.set(key, built);

    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();

      if (!oldest.done) this.entries.delete(oldest.value);
    }

    return built;
  }

  clear(): void {
    this.entries.clear();
  }
}
