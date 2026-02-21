export type DomainDescriptor = {
  id: string;
  summary: string;
  capabilities: string[];
  ownerFile: string;
};

export class DomainRegistry {
  private readonly items = new Map<string, DomainDescriptor>();

  register(domain: DomainDescriptor): void {
    const id = domain.id.trim().toLowerCase();
    if (!id) {
      throw new Error("Domain id vacío");
    }
    this.items.set(id, {
      ...domain,
      id,
      capabilities: Array.from(new Set(domain.capabilities.map((item) => item.trim()).filter(Boolean))),
    });
  }

  list(): DomainDescriptor[] {
    return [...this.items.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  formatSummary(): string {
    const items = this.list();
    if (items.length === 0) {
      return "Domains: sin registros";
    }
    return [
      `Domains: ${items.length}`,
      ...items.map((item) => {
        return `- ${item.id}: ${item.summary} | caps=${item.capabilities.join(", ")} | owner=${item.ownerFile}`;
      }),
    ].join("\n");
  }
}
