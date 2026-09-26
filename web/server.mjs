import { createReadStream } from "node:fs";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const webRootPath = resolve(webRoot);
const projectRoot = resolve(webRootPath, "..");
const transactionDirectory = join(projectRoot, ".lumo_transactions");
const historyPath = join(projectRoot, ".lumo_budget_history.csv");
const dataPath = join(projectRoot, ".ledger_data.json");
const port = Number(process.env.PORT ?? 4173);
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};

function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted && character === '"' && line[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields;
}

function transactionDate(timestamp, cycleId) {
  const isoDate = /^(\d{4}-\d{2}-\d{2})/.exec(timestamp)?.[1];
  if (isoDate && !timestamp.includes("T")) return isoDate;
  const legacyTimestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{1,2})$/.exec(timestamp);
  if (legacyTimestamp) {
    const [, year, month, , day] = legacyTimestamp;
    return `${year}-${month}-${day.padStart(2, "0")}`;
  }
  return isoDate ?? cycleId;
}

function readTransactionsFromCsv() {
  return readdir(transactionDirectory, { withFileTypes: true }).then(async (entries) => {
    const files = entries
      .filter((entry) => entry.isFile() && /^\d{4},\d{2},\d{2}\.csv$/.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    const transactions = [];
    for (const entry of files) {
      const contents = await readFile(join(transactionDirectory, entry.name), "utf8");
      const lines = contents.split(/\r?\n/).filter(Boolean);
      for (const [rowIndex, line] of lines.entries()) {
        const [timestamp, rawAmount, label, category, cycleId, status] = parseCsvLine(line);
        const amount = Number(rawAmount);
        if (!Number.isFinite(amount) || !cycleId) continue;
        const id = `csv:${entry.name}:${rowIndex}`;
        transactions.push({
          id,
          sourceId: id,
          createdAt: Date.parse(transactionDate(timestamp, cycleId)) || 0,
          date: transactionDate(timestamp, cycleId),
          amount,
          label: label ?? "",
          category: category || "misc",
          reserved: status === "reserved",
        });
      }
    }
    return transactions;
  }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

async function readLatestBudgetFromHistory() {
  try {
    const lines = (await readFile(historyPath, "utf8")).split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return null;
    const headers = parseCsvLine(lines[0]);
    const values = parseCsvLine(lines.at(-1));
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
    const fixed = Number(row.fixed) || 0;
    const extraTransport = Number(row.extra_transport) || 0;
    return {
      income: String(Number(row.income) || 0),
      openingBalance: String(Number(row.opening_balance) || 0),
      fixedCosts: String(Math.max(0, fixed - extraTransport)),
      buffer: String(Number(row.buffer) || 0),
      carryover: String(Number(row.carryover_next) || 0),
      extraTransport: String(extraTransport),
      cycleStart: row.start || "",
      cycleEnd: row.end || "",
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeData(data) {
  const temporaryPath = `${dataPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temporaryPath, dataPath);
}

async function initializeData() {
  let data;
  try {
    data = JSON.parse(await readFile(dataPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    data = {
      version: 1,
      budget: await readLatestBudgetFromHistory(),
      transactions: [],
      deletedSourceIds: [],
    };
  }

  data.version = 1;
  data.transactions = Array.isArray(data.transactions) ? data.transactions : [];
  data.deletedSourceIds = Array.isArray(data.deletedSourceIds) ? data.deletedSourceIds : [];
  const knownSourceIds = new Set(data.transactions.map((transaction) => transaction.sourceId).filter(Boolean));
  const deletedSourceIds = new Set(data.deletedSourceIds);
  for (const transaction of await readTransactionsFromCsv()) {
    if (!knownSourceIds.has(transaction.sourceId) && !deletedSourceIds.has(transaction.sourceId)) {
      data.transactions.push(transaction);
      knownSourceIds.add(transaction.sourceId);
    }
  }
  await writeData(data);
  return data;
}

const dataReady = initializeData();
let storeQueue = Promise.resolve();

function withStoreLock(operation) {
  const result = storeQueue.then(operation);
  storeQueue = result.catch(() => {});
  return result;
}

async function refreshCsvTransactions() {
  return withStoreLock(async () => {
    const data = await dataReady;
    const knownSourceIds = new Set(data.transactions.map((transaction) => transaction.sourceId).filter(Boolean));
    const deletedSourceIds = new Set(data.deletedSourceIds);
    let changed = false;
    for (const transaction of await readTransactionsFromCsv()) {
      if (!knownSourceIds.has(transaction.sourceId) && !deletedSourceIds.has(transaction.sourceId)) {
        data.transactions.push(transaction);
        knownSourceIds.add(transaction.sourceId);
        changed = true;
      }
    }
    if (changed) await writeData(data);
    return data;
  });
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new Error("Request body exceeds 5 MB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/api/state" && request.method === "GET") {
    try {
      sendJson(response, 200, await refreshCsvTransactions());
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return;
  }

  if (pathname === "/api/state" && request.method === "PUT") {
    try {
      const incoming = await readJsonBody(request);
      if (!incoming || typeof incoming !== "object" || !Array.isArray(incoming.transactions)) {
        sendJson(response, 400, { error: "Invalid local budget data" });
        return;
      }
      await withStoreLock(async () => {
        const data = await dataReady;
        data.budget = incoming.budget && typeof incoming.budget === "object" ? incoming.budget : data.budget;
        data.transactions = incoming.transactions;
        data.deletedSourceIds = Array.isArray(incoming.deletedSourceIds) ? incoming.deletedSourceIds : data.deletedSourceIds;
        await writeData(data);
      });
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405).end("Method not allowed");
    return;
  }

  const pathnameForFile = decodeURIComponent(pathname);
  const relativePath = normalize(pathnameForFile === "/" ? "index.html" : pathnameForFile.slice(1));
  const filePath = resolve(join(webRootPath, relativePath));
  if (filePath !== webRootPath && !filePath.startsWith(webRootPath + sep)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    response.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream" });
    if (request.method === "HEAD") response.end();
    else response.end(file);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Stop the existing Ledger server or set PORT to another port.`);
  } else {
    console.error(`Could not start Ledger server: ${error.message}`);
  }
  process.exitCode = 1;
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Ledger is running at http://127.0.0.1:${port}`);
  console.log(`Local data file: ${dataPath}`);
});
