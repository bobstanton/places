export class ServiceRegistry<TService> {
  private services: Map<string, TService> = new Map();

  register(name: string, service: TService): void {
    this.services.set(name.toLowerCase(), service);
  }

  get(name: string): TService | undefined {
    return this.services.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.services.has(name.toLowerCase());
  }

  getAll(): TService[] {
    return Array.from(this.services.values());
  }

  getNames(): string[] {
    return Array.from(this.services.keys());
  }

  get size(): number {
    return this.services.size;
  }

  forEach(callback: (service: TService, name: string) => void): void {
    this.services.forEach((service, name) => callback(service, name));
  }

  clear(): void {
    this.services.clear();
  }

  getFirst(): TService | undefined {
    const first = this.services.values().next();

    return first.done ? undefined : first.value;
  }

  getMultiple(namesString: string): Array<{ name: string; service: TService }> {
    const results: Array<{ name: string; service: TService }> = [];

    const names = namesString
      .split(",")
      .map((n) => n.trim().toLowerCase())
      .filter((n) => n.length > 0);

    for (const name of names) {
      const service = this.get(name);

      if (service) {
        results.push({ name, service });
      }
    }

    return results;
  }
}
