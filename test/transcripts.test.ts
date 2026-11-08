import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { carpetaProyectos, codificaCwd, comprobarTranscripts, type DiscoTranscripts, discoReal } from "../server/transcripts.ts";

/** A fake disk: the set of files that exist, and the folders under each directory. */
function discoFalso(ficheros: readonly string[], env: Record<string, string | undefined> = {}, home = "/home/u"): DiscoTranscripts & { consultas: string[] } {
  const consultas: string[] = [];
  const existentes = new Set(ficheros);
  return {
    env,
    home,
    consultas,
    existe: async (ruta) => (consultas.push(ruta), existentes.has(ruta)),
    lista: async (ruta) => {
      const prefijo = `${ruta}/`;
      return [...new Set(ficheros.filter((f) => f.startsWith(prefijo)).map((f) => f.slice(prefijo.length).split("/")[0] as string))];
    },
  };
}

const ID = "1effac8a-1142-48b6-b7eb-24d3fa60013d";

test("codificaCwd replaces everything that is not a letter or a digit, like Claude does", () => {
  assert.equal(codificaCwd("/Users/dibanez/Workspace/Environment"), "-Users-dibanez-Workspace-Environment");
  assert.equal(codificaCwd("/Users/dibanez/.local/state/x_y"), "-Users-dibanez--local-state-x-y");
});

test("carpetaProyectos: CLAUDE_CONFIG_DIR when set, else ~/.claude", () => {
  assert.equal(carpetaProyectos({ env: {}, home: "/home/u" }), "/home/u/.claude/projects");
  assert.equal(carpetaProyectos({ env: { CLAUDE_CONFIG_DIR: "/cfg/claude" }, home: "/home/u" }), "/cfg/claude/projects");
  assert.equal(carpetaProyectos({ env: { CLAUDE_CONFIG_DIR: "  " }, home: "/home/u" }), "/home/u/.claude/projects", "blank means unset");
});

test("a transcript in the folder of its directory is found with a single lookup", async () => {
  const disco = discoFalso([`/home/u/.claude/projects/-work-proyecto/${ID}.jsonl`]);
  const [r] = await comprobarTranscripts(disco, [{ provider: "claude", sessionId: ID, cwd: "/work/proyecto" }]);
  assert.deepEqual(r, { provider: "claude", sessionId: ID, existe: true });
  assert.equal(disco.consultas.length, 1);
});

test("a transcript under another project folder is found by scanning (the directory was renamed or is a symlink)", async () => {
  const disco = discoFalso([`/home/u/.claude/projects/-otro-nombre/${ID}.jsonl`, "/home/u/.claude/projects/-x/otra.jsonl"]);
  const [r] = await comprobarTranscripts(disco, [{ provider: "claude", sessionId: ID, cwd: "/work/proyecto" }]);
  assert.equal(r?.existe, true);
});

test("a missing transcript is false, and CLAUDE_CONFIG_DIR moves the search", async () => {
  const sinNada = discoFalso([`/home/u/.claude/projects/-work-proyecto/otra.jsonl`]);
  assert.equal((await comprobarTranscripts(sinNada, [{ provider: "claude", sessionId: ID, cwd: "/work/proyecto" }]))[0]?.existe, false);
  const enOtraCuenta = discoFalso([`/cfg/claude/projects/-work-proyecto/${ID}.jsonl`], { CLAUDE_CONFIG_DIR: "/cfg/claude" });
  assert.equal((await comprobarTranscripts(enOtraCuenta, [{ provider: "claude", sessionId: ID, cwd: "/work/proyecto" }]))[0]?.existe, true);
  const ignorado = discoFalso([`/home/u/.claude/projects/-work-proyecto/${ID}.jsonl`], { CLAUDE_CONFIG_DIR: "/cfg/claude" });
  assert.equal((await comprobarTranscripts(ignorado, [{ provider: "claude", sessionId: ID, cwd: "/work/proyecto" }]))[0]?.existe, false, "the default folder is not searched when another is configured");
});

test("other providers answer null (unknown): the caller treats them as restorable", async () => {
  const disco = discoFalso([]);
  const [r] = await comprobarTranscripts(disco, [{ provider: "codex", sessionId: "abc", cwd: "/work" }]);
  assert.deepEqual(r, { provider: "codex", sessionId: "abc", existe: null });
  assert.equal(disco.consultas.length, 0, "nothing is read for a provider this plugin cannot look into");
});

test("a session id that could climb out of the projects folder is not a session", async () => {
  const disco = discoFalso(["/home/u/.claude/secreto.jsonl"]);
  for (const sessionId of ["../../secreto", "a/b", "", ".hidden", "x y"]) {
    const [r] = await comprobarTranscripts(disco, [{ provider: "claude", sessionId, cwd: "/work" }]);
    assert.equal(r?.existe, false, `«${sessionId}»`);
  }
  assert.equal(disco.consultas.length, 0);
});

test("many sessions: results keep the input order and the project folders are listed once", async () => {
  let listados = 0;
  const base = discoFalso([`/home/u/.claude/projects/-a/uno.jsonl`, `/home/u/.claude/projects/-b/tres.jsonl`]);
  const disco: DiscoTranscripts = { ...base, lista: async (ruta) => (listados++, base.lista(ruta)) };
  const resultados = await comprobarTranscripts(disco, [
    { provider: "claude", sessionId: "uno", cwd: "/x" },
    { provider: "claude", sessionId: "dos", cwd: "/x" },
    { provider: "claude", sessionId: "tres", cwd: "/x" },
    { provider: "claude", sessionId: "cuatro", cwd: "/x" },
  ]);
  assert.deepEqual(
    resultados.map((r) => [r.sessionId, r.existe]),
    [["uno", true], ["dos", false], ["tres", true], ["cuatro", false]],
  );
  assert.equal(listados, 1);
});

test("the real disk: finds a file in a project folder, misses a missing one, survives a missing projects folder", async () => {
  const raiz = await mkdtemp(join(tmpdir(), "archivadas-"));
  try {
    await mkdir(join(raiz, "projects", "-work-proyecto"), { recursive: true });
    await writeFile(join(raiz, "projects", "-work-proyecto", `${ID}.jsonl`), "{}\n");
    const disco: DiscoTranscripts = { ...discoReal, env: { CLAUDE_CONFIG_DIR: raiz } };
    const resultados = await comprobarTranscripts(disco, [
      { provider: "claude", sessionId: ID, cwd: "/work/proyecto" },
      { provider: "claude", sessionId: "no-existe", cwd: "/work/proyecto" },
    ]);
    assert.deepEqual(
      resultados.map((r) => r.existe),
      [true, false],
    );
    const vacio = await comprobarTranscripts({ ...discoReal, env: { CLAUDE_CONFIG_DIR: join(raiz, "nada") } }, [{ provider: "claude", sessionId: ID, cwd: "/work" }]);
    assert.equal(vacio[0]?.existe, false);
  } finally {
    await rm(raiz, { recursive: true, force: true });
  }
});
