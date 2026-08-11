import { createInterface } from "node:readline";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MEMORYHUB_DIR, getConfig, requireEmbedConfig, setConfig, type MemoryHubConfig } from "./config.js";
import { embed, healthCheck, llm } from "./memory.js";

export interface ConfigureOptions {
  sets: Record<string, string>;
  file?: string;
  noVerify: boolean;
  help: boolean;
}

const USAGE = `memoryhub configure

Guided setup for Qdrant, LLM, and embedding API settings.

Usage:
  memoryhub configure                 Interactive wizard
  memoryhub configure --set KEY=VALUE Scripted setup (repeatable)
  memoryhub configure --file cfg.json Import settings from a config JSON file
  memoryhub configure --no-verify     Skip connectivity and API checks
  memoryhub configure --help          Show this help

Valid keys: QDRANT_URL, COLLECTION, VECTOR_SIZE, LLM_MODEL, LLM_BASE,
            LLM_KEY, EMBED_MODEL, EMBED_BASE, EMBED_KEY, RETRY_DELAY_MS
`;

function applySet(opts: ConfigureOptions, pair: string) {
  const idx = pair.indexOf("=");
  if (idx <= 0) throw new Error(`--set requires KEY=VALUE, got "${pair}"`);
  opts.sets[pair.slice(0, idx)] = pair.slice(idx + 1);
}

export function parseFlags(args: string[]): ConfigureOptions {
  const opts: ConfigureOptions = { sets: {}, help: false, noVerify: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--no-verify") opts.noVerify = true;
    else if (arg === "--set") {
      const pair = args[++i];
      if (pair === undefined) throw new Error("--set requires KEY=VALUE");
      applySet(opts, pair);
    } else if (arg.startsWith("--set=")) {
      applySet(opts, arg.slice("--set=".length));
    } else if (arg === "--file") {
      opts.file = args[++i];
      if (opts.file === undefined) throw new Error("--file requires a path");
    } else if (arg.startsWith("--file=")) {
      opts.file = arg.slice("--file=".length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

const FILE_KEY_MAP: Record<string, string> = {
  "qdrant.url": "QDRANT_URL",
  collection: "COLLECTION",
  vector_size: "VECTOR_SIZE",
  "llm.model": "LLM_MODEL",
  "llm.base_url": "LLM_BASE",
  "llm.api_key": "LLM_KEY",
  "embedder.model": "EMBED_MODEL",
  "embedder.base_url": "EMBED_BASE",
  "embedder.api_key": "EMBED_KEY",
};

function dotGet(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
    obj
  );
}

export function configFromFile(path: string): Record<string, string> {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new Error(`Cannot read config file ${path}: invalid JSON`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`Config file ${path} must contain a JSON object`);
  }
  const result: Record<string, string> = {};
  for (const [dot, key] of Object.entries(FILE_KEY_MAP)) {
    const value = dotGet(data, dot);
    if (typeof value === "string" || typeof value === "number") result[key] = String(value);
  }
  return result;
}

export function buildConfig(values: Record<string, string>): MemoryHubConfig {
  const cfg: MemoryHubConfig = {};
  if (values.QDRANT_URL) cfg.qdrant = { url: values.QDRANT_URL };
  if (values.COLLECTION) cfg.collection = values.COLLECTION;
  if (values.VECTOR_SIZE) {
    const n = Number(values.VECTOR_SIZE);
    if (isNaN(n) || n <= 0) throw new Error(`VECTOR_SIZE must be a positive number, got "${values.VECTOR_SIZE}"`);
    cfg.vector_size = n;
  }
  if (values.LLM_MODEL || values.LLM_BASE || values.LLM_KEY) {
    cfg.llm = {};
    if (values.LLM_MODEL) cfg.llm.model = values.LLM_MODEL;
    if (values.LLM_BASE) cfg.llm.base_url = values.LLM_BASE;
    if (values.LLM_KEY) cfg.llm.api_key = values.LLM_KEY;
  }
  if (values.EMBED_MODEL || values.EMBED_BASE || values.EMBED_KEY) {
    cfg.embedder = {};
    if (values.EMBED_MODEL) cfg.embedder.model = values.EMBED_MODEL;
    if (values.EMBED_BASE) cfg.embedder.base_url = values.EMBED_BASE;
    if (values.EMBED_KEY) cfg.embedder.api_key = values.EMBED_KEY;
  }
  return cfg;
}

export function readConfigFile(path: string): MemoryHubConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as MemoryHubConfig;
  } catch {
    console.error(`memoryhub: warning: existing config ${path} is not valid JSON — it will be overwritten`);
    return {};
  }
}

function mergeConfigs(base: MemoryHubConfig, extra: MemoryHubConfig): MemoryHubConfig {
  const out: MemoryHubConfig = { ...base };
  if (extra.qdrant) out.qdrant = { ...base.qdrant, ...extra.qdrant };
  if (extra.collection !== undefined) out.collection = extra.collection;
  if (extra.vector_size !== undefined) out.vector_size = extra.vector_size;
  if (extra.llm) out.llm = { ...base.llm, ...extra.llm };
  if (extra.embedder) out.embedder = { ...base.embedder, ...extra.embedder };
  return out;
}

export function writeConfigFile(path: string, config: MemoryHubConfig): void {
  const merged = mergeConfigs(readConfigFile(path), config);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export async function verifySettings(): Promise<{ name: string; ok: boolean; message: string }[]> {
  const results: { name: string; ok: boolean; message: string }[] = [];
  try {
    const hc = JSON.parse(await healthCheck());
    results.push({ name: "Qdrant", ok: hc.status === "ok", message: hc.status === "ok" ? "connected" : "unreachable" });
  } catch (e) {
    results.push({ name: "Qdrant", ok: false, message: e instanceof Error ? e.message : String(e) });
  }
  try {
    requireEmbedConfig();
    await embed("memoryhub");
    results.push({ name: "Embedding API", ok: true, message: "ok" });
  } catch (e) {
    results.push({ name: "Embedding API", ok: false, message: e instanceof Error ? e.message : String(e) });
  }
  try {
    const out = await llm([{ role: "user", content: "Reply with exactly: OK" }]);
    results.push({ name: "LLM API", ok: out.length > 0, message: out.length > 0 ? `ok: ${out.trim().slice(0, 60)}` : "empty response" });
  } catch (e) {
    results.push({ name: "LLM API", ok: false, message: e instanceof Error ? e.message : String(e) });
  }
  return results;
}

interface Promptable {
  question(prompt: string): Promise<string>;
  secret(prompt: string): Promise<string>;
  yesNo(prompt: string, fallback: boolean): Promise<boolean>;
}

function makePrompter(): Promptable {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));
  const askSecret = (prompt: string): Promise<string> => {
    const rlAny = rl as unknown as { _writeToOutput: (s: string) => void };
    const original = rlAny._writeToOutput;
    rlAny._writeToOutput = (s: string) => {
      if (s === "\n" || s === "\r\n") original.call(rl, "\n");
    };
    return new Promise((resolve) => {
      rl.question(prompt, (answer) => {
        rlAny._writeToOutput = original;
        resolve(answer);
      });
    });
  };
  return {
    question: ask,
    secret: askSecret,
    yesNo: async (prompt, fallback) => {
      const answer = (await ask(`${prompt} [${fallback ? "Y" : "y"}/${fallback ? "n" : "N"}]: `)).trim().toLowerCase();
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
      return fallback;
    },
  };
}

async function runWizard(values: Record<string, string>, p: Promptable): Promise<void> {
  const ask = async (prompt: string, key: string): Promise<string> => {
    const current = values[key] || getConfig(key);
    const suffix = current ? ` [${current}]` : "";
    const answer = (await p.question(`${prompt}${suffix}: `)).trim();
    return answer || current;
  };
  console.log("\nmemoryhub configuration wizard\n");
  console.log("Press Enter to keep a shown default.\n");
  const qdrantUrl = await ask("Qdrant URL", "QDRANT_URL");
  if (qdrantUrl) values.QDRANT_URL = qdrantUrl;
  const collection = await ask("Collection name", "COLLECTION");
  if (collection) values.COLLECTION = collection;
  const vectorSize = await ask("Vector size", "VECTOR_SIZE");
  if (vectorSize) values.VECTOR_SIZE = vectorSize;
  const llmModel = await ask("LLM model", "LLM_MODEL");
  if (llmModel) values.LLM_MODEL = llmModel;
  const llmBase = await ask("LLM base URL", "LLM_BASE");
  if (llmBase) values.LLM_BASE = llmBase;
  const llmKey = await ask("LLM API key", "LLM_KEY");
  if (llmKey) values.LLM_KEY = llmKey;
  const embedModel = await ask("Embedding model", "EMBED_MODEL");
  if (embedModel) values.EMBED_MODEL = embedModel;
  const embedBase = await ask("Embedding base URL", "EMBED_BASE");
  if (embedBase) values.EMBED_BASE = embedBase;
  const embedKey = await p.secret("Embedding API key (hidden)");
  if (embedKey.trim()) values.EMBED_KEY = embedKey.trim();
  console.log("");
}

export async function runConfigure(argv: string[]): Promise<void> {
  let flags: ConfigureOptions;
  try {
    flags = parseFlags(argv);
  } catch (e) {
    console.error(`memoryhub: ${e instanceof Error ? e.message : String(e)}`);
    console.error("Run `memoryhub configure --help` for usage.");
    process.exit(1);
  }
  if (flags.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const values: Record<string, string> = {};
  if (flags.file) {
    try {
      Object.assign(values, configFromFile(flags.file));
    } catch (e) {
      console.error(`memoryhub: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }
  Object.assign(values, flags.sets);
  for (const [key, value] of Object.entries(values)) {
    try {
      setConfig(key, value);
    } catch (e) {
      console.error(`memoryhub: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }
  const interactive = process.stdin.isTTY === true;
  if (interactive) {
    const p = makePrompter();
    await runWizard(values, p);
    let results = flags.noVerify ? [] : await verifySettings();
    if (results.length) {
      for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}: ${r.message}`);
      while (results.some((r) => !r.ok)) {
        const choice = (await p.question("Some checks failed. retry / save anyway / cancel [cancel]: ")).trim().toLowerCase();
        if (choice === "save" || choice === "s") break;
        if (choice === "retry" || choice === "r") {
          results = await verifySettings();
          for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}: ${r.message}`);
        } else {
          console.log("memoryhub: cancelled, nothing saved");
          process.exit(0);
        }
      }
    }
    const globalPath = join(MEMORYHUB_DIR, "config.json");
    writeConfigFile(globalPath, buildConfig(values));
    console.log("✓ Saved to " + globalPath);
    if (await p.yesNo("Also write memoryhub.json in the current directory?", false)) {
      const projectPath = join(process.cwd(), "memoryhub.json");
      writeConfigFile(projectPath, buildConfig(values));
      console.log("✓ Saved to " + projectPath);
    }
  } else {
    if (!flags.noVerify) {
      const results = await verifySettings();
      for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}: ${r.message}`);
    }
    const globalPath = join(MEMORYHUB_DIR, "config.json");
    writeConfigFile(globalPath, buildConfig(values));
    console.log("✓ Saved to " + globalPath);
  }
  console.log("\nNext steps: run `memoryhub bootstrap` to start with Qdrant, or `memoryhub` for stdio mode.");
}
