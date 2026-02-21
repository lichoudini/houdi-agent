import type { IncomingMessage, ServerResponse } from "node:http";

export function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      return undefined;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

export function writeJsonResponse(res: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body, "utf8").toString(),
  });
  res.end(body);
}

export function isLocalBridgeAuthorized(req: IncomingMessage, bearerToken?: string): boolean {
  const token = bearerToken?.trim();
  if (!token) {
    return true;
  }
  const header = req.headers.authorization;
  if (!header) {
    return false;
  }
  const [scheme, value] = header.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer") {
    return false;
  }
  return (value ?? "").trim() === token;
}

export function readHttpRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    req.on("data", (chunk: Buffer | string) => {
      if (settled) {
        return;
      }
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bufferChunk.length;
      if (total > maxBytes) {
        req.destroy();
        fail(new Error(`request body excede ${maxBytes} bytes`));
        return;
      }
      chunks.push(bufferChunk);
    });

    req.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
