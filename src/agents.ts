import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const AgentProfileSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).default("."),
  allowCommands: z.array(z.string().trim().min(1)).min(1),
  workspaceOnly: z.boolean().default(false),
});

export type AgentProfile = z.infer<typeof AgentProfileSchema>;

function normalizeAgent(profile: AgentProfile): AgentProfile {
  const commands = Array.from(
    new Set(profile.allowCommands.map((command) => command.trim().toLowerCase())),
  );

  return {
    ...profile,
    cwd: profile.cwd.trim(),
    allowCommands: commands,
    workspaceOnly: Boolean(profile.workspaceOnly),
  };
}

export class AgentRegistry {
  private readonly byName = new Map<string, AgentProfile>();

  constructor(
    private readonly agentsDir: string,
    private readonly defaultAgentName: string,
  ) {}

  async load(): Promise<void> {
    const entries = await fs.readdir(this.agentsDir, { withFileTypes: true });
    const jsonFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));

    if (jsonFiles.length === 0) {
      throw new Error(`No agent profiles found in ${this.agentsDir}`);
    }

    this.byName.clear();

    for (const file of jsonFiles) {
      const filePath = path.join(this.agentsDir, file.name);
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = AgentProfileSchema.parse(JSON.parse(raw));
      const profile = normalizeAgent(parsed);
      this.byName.set(profile.name, profile);
    }

    if (!this.byName.has(this.defaultAgentName)) {
      throw new Error(
        `Default agent "${this.defaultAgentName}" not found in ${this.agentsDir}. Available: ${[...this.byName.keys()].join(", ")}`,
      );
    }
  }

  list(): AgentProfile[] {
    return [...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): AgentProfile | undefined {
    return this.byName.get(name);
  }

  require(name: string): AgentProfile {
    const profile = this.byName.get(name);
    if (!profile) {
      throw new Error(`Agent "${name}" not found`);
    }
    return profile;
  }

  getDefault(): AgentProfile {
    return this.require(this.defaultAgentName);
  }
}
