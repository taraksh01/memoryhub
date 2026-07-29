import { spawn } from "node:child_process";

const env = {
  ...process.env,
  LLM_BASE: process.env.LLM_BASE || process.env.LLM_BASE_URL,
  LLM_KEY: process.env.LLM_KEY || process.env.LLM_API_KEY,
};

const proc = spawn("node", ["./dist/index.js"], { stdio: ["pipe", "pipe", "inherit"], env });
let msgId = 0, buf = "", pending = {};
let pass = 0, fail = 0;
const fails = [];

proc.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending[msg.id]) {
        pending[msg.id](msg);
        delete pending[msg.id];
      }
    } catch {}
  }
});

function send(m, p = {}) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending[id] = resolve;
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p }) + "\n");
  });
}

async function call(name, args) {
  const r = await send("tools/call", { name, arguments: args });
  const content = r.result?.content?.[0]?.text || r.error?.message || "no result";
  try { return JSON.parse(content); } catch { return content; }
}

function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; fails.push(msg); console.error(`  FAIL: ${msg}`); }
}

async function main() {
  let step = 0;
  function log(s) { step++; console.log(`${String(step).padStart(2)}. ${s}`); }

  // ── Setup ──
  await send("initialize", { protocolVersion: "2024-11-05", capabilities: { tools: {} }, clientInfo: { name: "test", version: "1" } });
  await send("notifications/initialized", {});

  const uid = Date.now().toString(36);

  // ── 1. Basic tools ──
  log("health_check");
  const h = await call("health_check", {});
  ok(h.status === "ok" && h.qdrant === "connected", `health: ${JSON.stringify(h)}`);

  log("get_config — keys masked, all fields present");
  const cfg = await call("get_config", {});
  ok(cfg.LLM_KEY.includes("****"), `LLM_KEY not masked: ${cfg.LLM_KEY}`);
  ok(cfg.EMBED_KEY.includes("****"), `EMBED_KEY not masked: ${cfg.EMBED_KEY}`);
  ok(!!cfg.LLM_BASE, "LLM_BASE missing");
  ok(!!cfg.QDRANT_URL, "QDRANT_URL missing");
  ok(!!cfg.COLLECTION, "COLLECTION missing");
  ok(!!cfg.VECTOR_SIZE, "VECTOR_SIZE missing");
  ok(!!cfg.LLM_MODEL, "LLM_MODEL missing");
  ok(!!cfg.EMBED_MODEL, "EMBED_MODEL missing");

  log("memory_stats — returns collection info");
  const st = await call("memory_stats", {});
  ok(typeof st.vectors_count === "number", `stats: ${JSON.stringify(st)}`);
  ok(st.collection === "memories", `collection: ${st.collection}`);

  log("update_config — runtime override");
  const u1 = await call("update_config", { key: "VECTOR_SIZE", value: "999" });
  ok(u1.updated === "VECTOR_SIZE" && u1.value === "999", `update: ${JSON.stringify(u1)}`);
  // Verify
  const cfg2 = await call("get_config", {});
  ok(cfg2.VECTOR_SIZE === "999", `VECTOR_SIZE not updated: ${cfg2.VECTOR_SIZE}`);

  // ── 2. add_memories — edge cases ──
  log("add_memories — empty text (should error)");
  const e1 = await call("add_memories", { text: "" });
  ok(typeof e1 === "string" && e1.includes("Error"), `empty text: ${JSON.stringify(e1)}`);

  log("add_memories — text too long (>50K)");
  const longText = "x".repeat(50001);
  const e2 = await call("add_memories", { text: longText });
  ok(typeof e2 === "string" && e2.includes("Error"), `long text: ${JSON.stringify(e2).slice(0, 100)}`);

  log("add_memories — global");
  const g = await call("add_memories", { text: `Comprehensive global test memory with identifier ${uid}.` });
  ok(g.added >= 1, `global add: ${JSON.stringify(g)}`);
  const gTag = g.memories[0];

  log("add_memories — project with hyphens");
  const p1 = await call("add_memories", { text: `Comprehensive project test memory A1 with identifier ${uid}.`, project: "my-project" });
  ok(p1.added >= 1, `proj hyphens: ${JSON.stringify(p1)}`);

  log("add_memories — project with special chars");
  const p2 = await call("add_memories", { text: `Comprehensive project test memory A2 with identifier ${uid}.`, project: "my.repo/feature!@#" });
  ok(p2.added >= 1, `proj special: ${JSON.stringify(p2)}`);

  log("add_memories — project with spaces");
  const p3 = await call("add_memories", { text: `Comprehensive project test memory B with identifier ${uid}.`, project: "project with spaces" });
  ok(p3.added >= 1, `proj spaces: ${JSON.stringify(p3)}`);

  log("add_memories — empty string project (treated as global)");
  const p4 = await call("add_memories", { text: `Comprehensive no-project test memory with identifier ${uid}.`, project: "" });
  ok(p4.added >= 1, `empty proj: ${JSON.stringify(p4)}`);

  log("add_memories — undefined project (explicit global)");
  const p5 = await call("add_memories", { text: `Comprehensive undefined-project test memory with identifier ${uid}.` });
  ok(p5.added >= 1, `undefined proj: ${JSON.stringify(p5)}`);

  log("add_memories — project with very short name");
  const p6 = await call("add_memories", { text: `Comprehensive short-project test memory with identifier ${uid}.`, project: "x" });
  ok(p6.added >= 1, `short proj: ${JSON.stringify(p6)}`);

  // ── 3. search_memory — edge cases ──
  log("search_memory — empty query (should error)");
  const s1 = await call("search_memory", { query: "" });
  ok(typeof s1 === "string" && s1.includes("Error"), `empty query: ${JSON.stringify(s1)}`);

  log("search_memory — global (returns all)");
  const sAll = await call("search_memory", { query: uid, limit: 50 });
  ok(sAll.length >= 5, `global search: ${sAll.length} (expected >=5)`);

  log("search_memory — scoped by hyphen project");
  const sHyphen = await call("search_memory", { query: uid, limit: 10, project: "my-project" });
  ok(sHyphen.length >= 1, `hyphen scoped: ${sHyphen.length}`);

  log("search_memory — scoped by special char project");
  const sSpecial = await call("search_memory", { query: uid, limit: 10, project: "my.repo/feature!@#" });
  ok(sSpecial.length >= 1, `special scoped: ${sSpecial.length}`);

  log("search_memory — scoped by space project");
  const sSpaces = await call("search_memory", { query: uid, limit: 10, project: "project with spaces" });
  ok(sSpaces.length >= 1, `spaces scoped: ${sSpaces.length}`);

  log("search_memory — scoped by nonexistent project (empty)");
  const sNone = await call("search_memory", { query: uid, limit: 10, project: "__does_not_exist__" });
  ok(sNone.length === 0, `nonexistent scoped: ${sNone.length}`);

  log("search_memory — no scope leak between projects");
  for (const r of sHyphen) ok(!r.text.includes("spaces") && !r.text.includes("special"), `hyphen leaked: ${r.text.slice(0, 40)}`);
  for (const r of sSpecial) ok(!r.text.includes("spaces") && !r.text.includes("hyphen"), `special leaked`);
  for (const r of sSpaces) ok(!r.text.includes("hyphen") && !r.text.includes("special"), `spaces leaked`);

  log("search_memory — limit=0 (clamped to 1)");
  const sLimit0 = await call("search_memory", { query: uid, limit: 0 });
  ok(sLimit0.length >= 1, `limit=0 (clamped): ${sLimit0.length}`);

  log("search_memory — limit=1");
  const sLimit1 = await call("search_memory", { query: uid, limit: 1 });
  ok(sLimit1.length <= 1, `limit=1: ${sLimit1.length}`);

  log("search_memory — result shape");
  if (sAll.length > 0) {
    ok(typeof sAll[0].id === "string", `id type: ${typeof sAll[0].id}`);
    ok(typeof sAll[0].text === "string", `text type: ${typeof sAll[0].text}`);
    ok(typeof sAll[0].score === "number", `score type: ${typeof sAll[0].score}`);
  }

  // ── 4. list_memories — edge cases ──
  log("list_memories — global");
  const lAll = await call("list_memories", { limit: 100 });
  ok(lAll.memories.length > 0, `list global: ${lAll.memories.length}`);

  log("list_memories — scoped by hyphen project");
  const lHyphen = await call("list_memories", { limit: 100, project: "my-project" });
  ok(lHyphen.memories.length >= 1, `list hyphen: ${lHyphen.memories.length}`);

  log("list_memories — scoped by special char project");
  const lSpecial = await call("list_memories", { limit: 100, project: "my.repo/feature!@#" });
  ok(lSpecial.memories.length >= 1, `list special: ${lSpecial.memories.length}`);

  log("list_memories — scoped by nonexistent project (empty)");
  const lNone = await call("list_memories", { limit: 100, project: "__does_not_exist__" });
  ok(lNone.memories.length === 0, `list nonexistent: ${lNone.memories.length}`);

  log("list_memories — pagination offset works");
  const lFirst = await call("list_memories", { limit: 2 });
  const lSecond = await call("list_memories", { limit: 2, offset: lFirst.next_offset });
  if (lFirst.memories.length > 0 && lSecond.memories.length > 0) {
    ok(lFirst.memories[0].id !== lSecond.memories[0].id, `pagination returned same element`);
  }

  log("list_memories — offset=undefined/empty is ignored");
  const lNoOff = await call("list_memories", { limit: 5 });
  ok(lNoOff.memories.length > 0, `no offset: ${lNoOff.memories.length}`);

  log("list_memories — limit=0 clamped to 1");
  const lLimit0 = await call("list_memories", { limit: 0 });
  ok(Array.isArray(lLimit0.memories), `limit=0: ${JSON.stringify(lLimit0).slice(0, 60)}`);

  log("list_memories — result shape");
  if (lAll.memories.length > 0) {
    ok(typeof lAll.memories[0].id === "string", `list id type: ${typeof lAll.memories[0].id}`);
    ok(typeof lAll.memories[0].text === "string", `list text type: ${typeof lAll.memories[0].text}`);
  }

  // ── 5. get_memory — edge cases ──
  log("get_memory — existing memory");
  const firstId = lAll.memories[0].id;
  const gm = await call("get_memory", { memory_id: firstId });
  ok(gm.id === firstId, `get_memory id: ${JSON.stringify(gm)}`);
  ok(!!gm.text, `get_memory text empty`);

  log("get_memory — nonexistent UUID");
  const gmBad = await call("get_memory", { memory_id: "00000000-0000-0000-0000-000000000000" });
  ok(gmBad.error === "Memory not found", `nonexistent: ${JSON.stringify(gmBad)}`);

  log("get_memory — empty memory_id (should error)");
  const gmEmpty = await call("get_memory", { memory_id: "" });
  ok(typeof gmEmpty === "string" && gmEmpty.includes("Error"), `empty id: ${JSON.stringify(gmEmpty)}`);

  // ── 6. update_memory — edge cases ──
  log("update_memory — preserves project scope");
  const lProj = await call("list_memories", { limit: 10, project: "my-project" });
  if (lProj.memories.length > 0) {
    const target = lProj.memories[0];
    const up = await call("update_memory", { memory_id: target.id, text: `UPDATED: ${target.text}` });
    ok(up.updated === target.id, `update returned: ${JSON.stringify(up)}`);
    // Verify still in my-project
    const v = await call("search_memory", { query: "UPDATED", limit: 5, project: "my-project" });
    ok(v.some(r => r.id === target.id), `memory lost project scope after update`);
    // Verify not in other scope
    const v2 = await call("search_memory", { query: "UPDATED", limit: 5, project: "project with spaces" });
    ok(!v2.some(r => r.id === target.id), `memory leaked to wrong scope`);
  }

  log("update_memory — nonexistent ID (should error)");
  const upBad = await call("update_memory", { memory_id: "00000000-0000-0000-0000-000000000000", text: "should fail" });
  ok(upBad.error === "Memory not found" || (typeof upBad === "string" && upBad.includes("Error")), `update nonexistent: ${JSON.stringify(upBad)}`);

  log("update_memory — empty memory_id (should error)");
  const upEmpty = await call("update_memory", { memory_id: "", text: "should fail" });
  const isError1 = typeof upEmpty === "string" && upEmpty.includes("Error");
  const isError2 = upEmpty && upEmpty.error;
  ok(isError1 || isError2, `update empty id: ${JSON.stringify(upEmpty)}`);

  log("update_memory — empty text (should error)");
  const upEmptyT = await call("update_memory", { memory_id: firstId, text: "" });
  const isError3 = typeof upEmptyT === "string" && upEmptyT.includes("Error");
  const isError4 = upEmptyT && upEmptyT.error;
  ok(isError3 || isError4, `update empty text: ${JSON.stringify(upEmptyT)}`);

  // ── 7. delete_memories — edge cases ──
  log("delete_memories — empty IDs array (should error)");
  const dEmpty = await call("delete_memories", { ids: [] });
  ok(typeof dEmpty === "string" && dEmpty.includes("Error"), `delete empty: ${JSON.stringify(dEmpty)}`);

  log("delete_memories — nonexistent ID (should succeed — Qdrant is idempotent)");
  const dNonExist = await call("delete_memories", { ids: ["00000000-0000-0000-0000-000000000000"] });
  ok(typeof dNonExist.deleted === "number", `delete nonexistent: ${JSON.stringify(dNonExist)}`);

  log("delete_memories — real memory by ID");
  // Add a temporary memory for deletion
  const dTemp = await call("add_memories", { text: `delete_target_memory ${uid}` });
  if (dTemp.added >= 1) {
    const lTemp = await call("search_memory", { query: "delete_target_memory", limit: 5 });
    const targetMem = lTemp.find(r => r.text.includes(uid));
    if (targetMem) {
      const del = await call("delete_memories", { ids: [targetMem.id] });
      ok(del.deleted === 1, `delete count: ${JSON.stringify(del)}`);
      // Verify gone
      const vDel = await call("get_memory", { memory_id: targetMem.id });
      ok(vDel.error === "Memory not found", `memory still exists after delete`);
    }
  }

  // ── 8. delete_all_memories — edge cases ──
  log("delete_all_memories — scoped with project (returns count)");
  const delScoped = await call("delete_all_memories", { project: "project with spaces" });
  ok(typeof delScoped.deleted === "number", `delete_all scoped type: ${typeof delScoped.deleted}`);
  ok(delScoped.deleted >= 1, `delete_all spaces count: ${delScoped.deleted}`);

  const vDelSpaces = await call("search_memory", { query: uid, limit: 5, project: "project with spaces" });
  ok(vDelSpaces.length === 0, `spaces still exist: ${vDelSpaces.length}`);

  log("delete_all_memories — scoped nonexistent (returns 0)");
  const delNone = await call("delete_all_memories", { project: "__does_not_exist__" });
  ok(delNone.deleted === 0, `nonexistent count: ${delNone.deleted}`);

  log("delete_all_memories — scoped by short name");
  const delX = await call("delete_all_memories", { project: "x" });
  ok(typeof delX.deleted === "number", `short proj count: ${delX.deleted}`);

  // ── 9. Cleanup remaining test data ──
  log("Cleanup — delete remaining test memories by ID");
  const remaining = await call("list_memories", { limit: 200 });
  const toDel = remaining.memories.filter(m => m.text.includes(uid)).map(m => m.id);
  if (toDel.length > 0) {
    const delRemaining = await call("delete_memories", { ids: toDel });
    ok(delRemaining.deleted === toDel.length, `cleanup: ${delRemaining.deleted}/${toDel.length}`);
  }
  // Also clean my-project and special char project
  const delMP = await call("delete_all_memories", { project: "my-project" });
  ok(typeof delMP.deleted === "number", `cleanup my-project: ${delMP.deleted}`);
  const delSC = await call("delete_all_memories", { project: "my.repo/feature!@#" });
  ok(typeof delSC.deleted === "number", `cleanup special: ${delSC.deleted}`);
  const delHyphen = await call("delete_all_memories", { project: "my-project" });
  ok(delHyphen.deleted === 0, `my-project already clean: ${delHyphen.deleted}`);

  // ── 10. Repeated calls / idempotency ──
  log("Idempotency — repeated search same params");
  const r1 = await call("search_memory", { query: "test", limit: 5 });
  const r2 = await call("search_memory", { query: "test", limit: 5 });
  ok(JSON.stringify(r1) === JSON.stringify(r2), `repeated search differs`);

  log("Idempotency — repeated stats");
  const st1 = await call("memory_stats", {});
  const st2 = await call("memory_stats", {});
  ok(JSON.stringify(st1) === JSON.stringify(st2), `repeated stats differs`);

  // ── Summary ──
  const total = pass + fail;
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  ${pass}/${total} passed, ${fail} failed`);
  if (fails.length) console.log(`  Failures:\n    ${fails.map(f => `    • ${f}`).join("\n")}`);
  console.log(`${"=".repeat(50)}`);
  if (fail > 0) process.exit(1);
  proc.stdin.end();
}

main().catch(e => { console.error("TEST ERROR:", e); proc.kill(); process.exit(1); });
