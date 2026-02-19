import fs from "node:fs";
import path from "node:path";

const DEFAULT_LOCK_PATH = path.join("/tmp", "houdi-agent.lock");

type LockPayload = {
  pid: number;
  startedAt: string;
};

function readLockPid(lockPath: string): number | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof parsed.pid === "number" && Number.isFinite(parsed.pid)) {
      return parsed.pid;
    }
    return null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeLockFile(lockPath: string): void {
  const payload: LockPayload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx" });
}

export function acquireSingleInstanceLock(lockPath = DEFAULT_LOCK_PATH): () => void {
  const tryAcquire = () => {
    writeLockFile(lockPath);
  };

  try {
    tryAcquire();
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code !== "EEXIST") {
      throw error;
    }

    const existingPid = readLockPid(lockPath);
    if (existingPid && isProcessAlive(existingPid) && existingPid !== process.pid) {
      throw new Error(
        `Otra instancia de Houdi Agent ya está activa (pid ${existingPid}). Cierra la anterior antes de iniciar una nueva.`,
      );
    }

    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Ignore stale lock cleanup race.
    }

    tryAcquire();
  }

  const release = () => {
    try {
      const currentPid = readLockPid(lockPath);
      if (currentPid === process.pid) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // Ignore cleanup errors.
    }
  };

  process.on("exit", release);
  process.on("SIGINT", () => {
    release();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    release();
    process.exit(0);
  });

  return release;
}

