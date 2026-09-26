import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dataPath = join(projectRoot, ".ledger_data.json");
const email = (process.env.LEDGER_EMAIL ?? "").trim().toLowerCase();

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("Set LEDGER_EMAIL to the exact email allowed by Cloudflare Access.");
  process.exit(1);
}

const source = JSON.parse(await readFile(dataPath, "utf8"));
const state = {
  version: 1,
  budget: source.budget && typeof source.budget === "object" ? source.budget : {},
  transactions: Array.isArray(source.transactions) ? source.transactions : [],
  deletedSourceIds: Array.isArray(source.deletedSourceIds) ? source.deletedSourceIds : [],
};
const serialized = JSON.stringify(state);
if (Buffer.byteLength(serialized, "utf8") > 1_800_000) {
  throw new Error("Local Ledger data exceeds the import size limit");
}

const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const sql = `INSERT INTO ledger_state (owner_email, state_json, updated_at) VALUES (${sqlLiteral(email)}, ${sqlLiteral(serialized)}, CURRENT_TIMESTAMP) ON CONFLICT(owner_email) DO NOTHING;\n`;
const tempDirectory = await mkdtemp(join(tmpdir(), "ledger-d1-import-"));
const tempSqlPath = join(tempDirectory, "import.sql");

try {
  await writeFile(tempSqlPath, sql, { encoding: "utf8", mode: 0o600 });
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  execFileSync(executable, ["wrangler", "d1", "execute", "ledger", "--remote", `--file=${tempSqlPath}`], {
    cwd: projectRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  console.log(`Imported ${state.transactions.length} transactions for ${email}.`);
  console.log("This import only inserts if this account has no existing Ledger row.");
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}