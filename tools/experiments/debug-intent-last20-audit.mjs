import fs from "node:fs/promises";
import path from "node:path";

const filePath = path.resolve(process.cwd(), "houdi-audit.log");

function parseArg(name, fallback = "") {
  const hit = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (!hit) {
    return fallback;
  }
  return hit.slice(name.length + 1);
}

function parseCsvSet(raw) {
  return new Set(
    String(raw || "")
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean),
  );
}

const positionalLimit = process.argv.find((arg) => /^\d+$/.test(arg));
const limit = Math.max(1, Math.min(200, Number.parseInt(positionalLimit || parseArg("--limit", "20"), 10) || 20));
const excludeRoutes = parseCsvSet(parseArg("--exclude", ""));

function printLine(line = "") {
  process.stdout.write(`${line}\n`);
}

function keyFor(row) {
  const details = row?.details ?? {};
  return `${row?.chatId ?? "-"}|${details?.route ?? "-"}|${details?.source ?? "-"}`;
}

function parseTs(input) {
  const ts = Date.parse(String(input || ""));
  return Number.isFinite(ts) ? ts : 0;
}

function isRouteIncluded(route) {
  if (!route) {
    return false;
  }
  return !excludeRoutes.has(route);
}

try {
  const raw = await fs.readFile(filePath, "utf8");
  const rows = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });

  const routeRows = rows
    .filter((row) => row?.type === "intent.route")
    .filter((row) => isRouteIncluded(String(row?.details?.handler || "").trim()));
  const executionRows = rows
    .filter((row) => row?.type === "intent.execution.result")
    .filter((row) => isRouteIncluded(String(row?.details?.route || "").trim()));
  const replyGuardRows = rows
    .filter((row) => row?.type === "intent.reply_guard.missing_response")
    .filter((row) => isRouteIncluded(String(row?.details?.route || "").trim()));

  const selectedRoutes = routeRows.slice(-limit);

  if (selectedRoutes.length === 0) {
    printLine(`Sin intent.route en ${filePath}`);
    process.exit(0);
  }

  const executionQueues = new Map();
  executionRows.forEach((row) => {
    const key = keyFor(row);
    const queue = executionQueues.get(key) || [];
    queue.push(row);
    executionQueues.set(key, queue);
  });
  for (const queue of executionQueues.values()) {
    queue.sort((a, b) => parseTs(a?.ts) - parseTs(b?.ts));
  }

  let okCount = 0;
  let failCount = 0;
  let missingExecCount = 0;
  let waitConfirmCount = 0;

  const maxExecLagMs = 120_000;
  const maxExecLeadMs = 5_000;

  printLine(`Archivo: ${filePath}`);
  printLine(`Eventos intent.route: ${selectedRoutes.length} (ultimos)`);
  if (excludeRoutes.size > 0) {
    printLine(`Rutas excluidas: ${Array.from(excludeRoutes).join(", ")}`);
  }
  printLine("");

  selectedRoutes.forEach((row, index) => {
    const details = row?.details ?? {};
    const ts = row?.ts ?? "-";
    const route = String(details?.handler ?? "-");
    const src = details?.source ?? "-";
    const semantic = details?.semanticRouterSelected ?? "-";
    const ai = details?.aiRouterSelected ?? "-";
    const typed = details?.typedRouteSummary ?? "-";
    const text = String(details?.textPreview ?? "").replace(/\s+/g, " ").trim();
    const queueKey = `${row?.chatId ?? "-"}|${route}|${src}`;
    const queue = executionQueues.get(queueKey) || [];
    const baseTs = parseTs(ts);
    let exec = null;
    while (queue.length > 0) {
      const candidate = queue[0];
      const candidateTs = parseTs(candidate?.ts);
      if (candidateTs < baseTs - maxExecLeadMs) {
        queue.shift();
        continue;
      }
      if (candidateTs > baseTs + maxExecLagMs) {
        break;
      }
      if (candidateTs >= baseTs - maxExecLeadMs && candidateTs <= baseTs + maxExecLagMs) {
        exec = queue.shift();
        break;
      }
    }
    if (queue.length === 0) {
      executionQueues.delete(queueKey);
    } else {
      executionQueues.set(queueKey, queue);
    }

    let execLabel = "NO_EXEC";
    let execError = "";
    if (exec) {
      const execDetails = exec?.details ?? {};
      const actionError = String(execDetails.actionError || "").trim();
      const success = typeof execDetails.actionSuccess === "boolean"
        ? Boolean(execDetails.actionSuccess)
        : Boolean(execDetails.handled);
      if (!success && actionError === "pending-plan-confirmation") {
        execLabel = "WAIT_CONFIRM";
        waitConfirmCount += 1;
      } else {
        execLabel = success ? "OK" : "FAIL";
      }
      execError = actionError;
      if (execLabel === "OK") {
        okCount += 1;
      } else if (execLabel === "FAIL") {
        failCount += 1;
      }
    } else {
      missingExecCount += 1;
    }

    const missingReply = replyGuardRows.some((event) => {
      const d = event?.details ?? {};
      if (String(d.route || "").trim() !== route) {
        return false;
      }
      if ((event?.chatId ?? null) !== (row?.chatId ?? null)) {
        return false;
      }
      const delta = parseTs(event?.ts) - baseTs;
      return delta >= 0 && delta <= maxExecLagMs;
    });

    printLine(
      `[${index + 1}] ${ts} src=${src} handler=${route} semantic=${semantic} ai=${ai} typed=${typed} exec=${execLabel}${missingReply ? " reply_guard=YES" : ""}`,
    );
    printLine(`  ${text}`);
    if (execError) {
      printLine(`  error: ${execError}`);
    }
  });

  printLine("");
  printLine(`Resumen: OK=${okCount} FAIL=${failCount} WAIT_CONFIRM=${waitConfirmCount} NO_EXEC=${missingExecCount}`);
} catch (error) {
  if (error?.code === "ENOENT") {
    printLine(`No existe: ${filePath}`);
    process.exit(0);
  }
  throw error;
}
