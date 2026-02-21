import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { AgentProfile } from "./agents.js";

export type TaskStatus = "running" | "completed" | "failed" | "killed" | "timeout";

export type Task = {
  id: string;
  agent: string;
  command: string;
  args: string[];
  cwd: string;
  startedAt: number;
  status: TaskStatus;
  pid?: number;
};

export type TaskResult = {
  task: Task;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  finishedAt: number;
};

type RunningTask = {
  task: Task;
  child: ChildProcessWithoutNullStreams;
  done: Promise<TaskResult>;
};

function appendTruncated(base: string, chunk: string, maxChars: number): string {
  const next = base + chunk;
  if (next.length <= maxChars) {
    return next;
  }
  return next.slice(next.length - maxChars);
}

function tokenizeExecInput(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const char of raw) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) {
    current += "\\";
  }
  if (quote) {
    throw new Error("Unclosed quote in command. Close all quotes before running /exec.");
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function parseExecInput(rawInput: string): { command: string; args: string[] } {
  const input = rawInput.trim();
  if (!input) {
    throw new Error("Missing command. Use: /exec <command> [args]");
  }
  if (input.includes("\n")) {
    throw new Error("Only single-line commands are allowed in this MVP");
  }

  const parts = tokenizeExecInput(input);
  const command = parts[0]?.trim().toLowerCase() ?? "";
  const args = parts.slice(1);

  if (!command) {
    throw new Error("Missing command");
  }

  if (!/^[a-z0-9._-]+$/.test(command)) {
    throw new Error(
      "Invalid command name. Use only simple binaries (letters, numbers, dot, dash, underscore)",
    );
  }

  return { command, args };
}

function buildTaskId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function containsPathEscape(raw: string): boolean {
  const value = raw.trim();
  if (!value) {
    return false;
  }
  if (value.startsWith("/") || value.startsWith("~")) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return true;
  }
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts.includes("..");
}

function validateWorkspaceOnlyExecution(command: string, args: string[]): void {
  const blockedCommands = new Set([
    "sudo",
    "su",
    "doas",
    "systemctl",
    "shutdown",
    "reboot",
    "poweroff",
    "mount",
    "umount",
    "chroot",
    "nsenter",
  ]);
  if (blockedCommands.has(command)) {
    throw new Error(`Command "${command}" is blocked in workspace-only mode.`);
  }
  for (const arg of args) {
    if (containsPathEscape(arg)) {
      throw new Error(`Argument "${arg}" escapes workspace-only policy.`);
    }
  }
}

export class TaskRunner {
  private readonly running = new Map<string, RunningTask>();

  constructor(
    private readonly timeoutMs: number,
    private readonly maxStdioChars: number,
  ) {}

  listRunning(): Task[] {
    return [...this.running.values()]
      .map((item) => item.task)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  kill(taskId: string): boolean {
    const entry = this.running.get(taskId);
    if (!entry) {
      return false;
    }
    const killed = entry.child.kill("SIGTERM");
    return killed;
  }

  killAll(): number {
    let count = 0;
    for (const entry of this.running.values()) {
      if (entry.child.kill("SIGTERM")) {
        count += 1;
      }
    }
    return count;
  }

  start(profile: AgentProfile, rawInput: string): RunningTask {
    const { command, args } = parseExecInput(rawInput);
    const allowsAll = profile.allowCommands.includes("*");
    if (!allowsAll && !profile.allowCommands.includes(command)) {
      throw new Error(
        `Command "${command}" is not allowed for agent "${profile.name}". Allowed: ${profile.allowCommands.join(", ")}`,
      );
    }

    const cwd = path.resolve(process.cwd(), profile.cwd);
    if (profile.workspaceOnly) {
      validateWorkspaceOnlyExecution(command, args);
    }
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: {
        ...process.env,
        ...(profile.workspaceOnly
          ? {
              HOME: cwd,
              PWD: cwd,
            }
          : {}),
      },
    });

    const task: Task = {
      id: buildTaskId(),
      agent: profile.name,
      command,
      args,
      cwd,
      startedAt: Date.now(),
      status: "running",
      pid: child.pid,
    };

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      task.status = "timeout";
      child.kill("SIGKILL");
    }, this.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendTruncated(stdout, chunk.toString("utf8"), this.maxStdioChars);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendTruncated(stderr, chunk.toString("utf8"), this.maxStdioChars);
    });

    const done = new Promise<TaskResult>((resolve) => {
      child.on("close", (exitCode, signal) => {
        clearTimeout(timeout);

        if (!timedOut) {
          if (signal === "SIGTERM" || signal === "SIGKILL") {
            task.status = "killed";
          } else if (exitCode === 0) {
            task.status = "completed";
          } else {
            task.status = "failed";
          }
        }

        resolve({
          task,
          stdout,
          stderr,
          timedOut,
          exitCode,
          signal,
          finishedAt: Date.now(),
        });
      });

      child.on("error", (error) => {
        clearTimeout(timeout);
        task.status = "failed";
        stderr = appendTruncated(stderr, `${error.message}\n`, this.maxStdioChars);
        resolve({
          task,
          stdout,
          stderr,
          timedOut,
          exitCode: 1,
          signal: null,
          finishedAt: Date.now(),
        });
      });
    }).finally(() => {
      this.running.delete(task.id);
    });

    const entry: RunningTask = { task, child, done };
    this.running.set(task.id, entry);
    return entry;
  }
}
