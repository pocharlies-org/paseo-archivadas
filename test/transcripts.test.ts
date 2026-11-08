import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { carpetaProyectos, codificaCwd, comprobarTranscripts, configDelProveedor, type DiscoTranscripts, discoReal } from "../server/transcripts.ts";

/** A fake disk: the set of files that exist, the folders under each directory, and the text of the files `lee` can read. */
function discoFalso(
  ficheros: readonly string[],
  env: Record<string, string | undefined> = {},
  home = "/home/u",
  textos: Record<string, string> = {},
): DiscoTranscripts & { consultas: string[] } {
  const consultas: string[] = [];
  const existentes = new Set(ficheros);
  return {
    env,
    home,
    consultas,
    lee: (ruta) => textos[ruta] ?? null,
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
    // A Paseo home of its own: the test must not read the config of whoever runs it.
    const paseo = join(raiz, "paseo-home");
    await mkdir(paseo);
    const disco: DiscoTranscripts = { ...discoReal, env: { CLAUDE_CONFIG_DIR: raiz, PASEO_HOME: paseo } };
    const resultados = await comprobarTranscripts(disco, [
      { provider: "claude", sessionId: ID, cwd: "/work/proyecto" },
      { provider: "claude", sessionId: "no-existe", cwd: "/work/proyecto" },
    ]);
    assert.deepEqual(
      resultados.map((r) => r.existe),
      [true, false],
    );
    const vacio = await comprobarTranscripts({ ...discoReal, env: { CLAUDE_CONFIG_DIR: join(raiz, "nada"), PASEO_HOME: paseo } }, [{ provider: "claude", sessionId: ID, cwd: "/work" }]);
    assert.equal(vacio[0]?.existe, false);
  } finally {
    await rm(raiz, { recursive: true, force: true });
  }
});

const configConEntorno = (env: unknown) => JSON.stringify({ agents: { providers: { claude: { command: ["claude"], env } } } });

test("carpetaProyectos: the Claude provider's env in the Paseo config beats the process env, which beats ~/.claude", () => {
  const config = (texto: string, paseo = "/home/u/.paseo") => ({ [`${paseo}/config.json`]: texto });
  const proveedor = configConEntorno({ CLAUDE_CONFIG_DIR: "/cuenta/proveedor", ANTHROPIC_BASE_URL: "https://x" });
  const base = { home: "/home/u" };
  assert.equal(carpetaProyectos({ ...base, env: { CLAUDE_CONFIG_DIR: "/cuenta/proceso" }, lee: (r) => config(proveedor)[r] ?? null }), "/cuenta/proveedor/projects", "provider env > process env");
  assert.equal(carpetaProyectos({ ...base, env: {}, lee: (r) => config(proveedor)[r] ?? null }), "/cuenta/proveedor/projects", "provider env > ~/.claude");
  const sinClave = configConEntorno({ ANTHROPIC_BASE_URL: "https://x" });
  assert.equal(carpetaProyectos({ ...base, env: { CLAUDE_CONFIG_DIR: "/cuenta/proceso" }, lee: (r) => config(sinClave)[r] ?? null }), "/cuenta/proceso/projects", "no provider value: process env");
  assert.equal(carpetaProyectos({ ...base, env: {}, lee: (r) => config(sinClave)[r] ?? null }), "/home/u/.claude/projects", "neither: ~/.claude");
  assert.equal(carpetaProyectos({ ...base, env: {}, lee: () => null }), "/home/u/.claude/projects", "no config file");
  assert.equal(carpetaProyectos({ ...base, env: {} }), "/home/u/.claude/projects", "a disk that cannot read files");
  const otroHome = { ...base, env: { PASEO_HOME: "/datos/paseo" }, lee: (r: string) => config(proveedor, "/datos/paseo")[r] ?? null };
  assert.equal(carpetaProyectos(otroHome), "/cuenta/proveedor/projects", "the config is looked up under PASEO_HOME");
  assert.equal(carpetaProyectos({ ...otroHome, env: {} }), "/home/u/.claude/projects", "and not under ~/.paseo when PASEO_HOME says otherwise");
});

test("configDelProveedor ignores a config that is not what it expects, and never logs it", () => {
  const lee = (texto: string) => ({ home: "/home/u", env: {}, lee: () => texto });
  for (const texto of [
    "",
    "no es json SECRETO-ANTHROPIC-TOKEN",
    '{"agents": {"providers": {"claude": {"env": "SECRETO"}}}',
    "null",
    "[]",
    '{"agents": []}',
    '{"agents": {"providers": {"claude": null}}}',
    '{"agents": {"providers": {"claude": {"env": []}}}}',
    configConEntorno({ CLAUDE_CONFIG_DIR: 7 }),
    configConEntorno({ CLAUDE_CONFIG_DIR: "   " }),
    configConEntorno({}),
  ]) {
    assert.equal(configDelProveedor(lee(texto)), undefined, texto);
  }
  assert.equal(configDelProveedor(lee(configConEntorno({ CLAUDE_CONFIG_DIR: "  /cuenta/x  " }))), "/cuenta/x", "trimmed");
  const consola = (["log", "info", "warn", "error", "debug"] as const).map((nivel) => mock.method(console, nivel, () => undefined));
  try {
    configDelProveedor(lee("{ SECRETO-ANTHROPIC-TOKEN"));
    assert.deepEqual(consola.map((m) => m.mock.callCount()), [0, 0, 0, 0, 0]);
  } finally {
    for (const m of consola) m.mock.restore();
  }
});

test("a transcript is looked up under the CLAUDE_CONFIG_DIR of the provider's env in the Paseo config", async () => {
  const disco = discoFalso(
    [`/cuenta/proveedor/projects/-work-proyecto/${ID}.jsonl`],
    { CLAUDE_CONFIG_DIR: "/cuenta/proceso" },
    "/home/u",
    { "/home/u/.paseo/config.json": configConEntorno({ CLAUDE_CONFIG_DIR: "/cuenta/proveedor" }) },
  );
  assert.equal((await comprobarTranscripts(disco, [{ provider: "claude", sessionId: ID, cwd: "/work/proyecto" }]))[0]?.existe, true);
  const delProceso = discoFalso(
    [`/cuenta/proceso/projects/-work-proyecto/${ID}.jsonl`],
    { CLAUDE_CONFIG_DIR: "/cuenta/proceso" },
    "/home/u",
    { "/home/u/.paseo/config.json": configConEntorno({ CLAUDE_CONFIG_DIR: "/cuenta/proveedor" }) },
  );
  assert.equal((await comprobarTranscripts(delProceso, [{ provider: "claude", sessionId: ID, cwd: "/work/proyecto" }]))[0]?.existe, false, "the provider's folder wins, the process one is not searched");
});

test("the real disk with a temp PASEO_HOME: the provider's CLAUDE_CONFIG_DIR is read from config.json; a broken file falls back", async () => {
  const raiz = await mkdtemp(join(tmpdir(), "archivadas-config-"));
  try {
    const cuentaProveedor = join(raiz, "cuenta-proveedor");
    const cuentaProceso = join(raiz, "cuenta-proceso");
    const paseo = join(raiz, "paseo");
    await mkdir(join(cuentaProveedor, "projects", "-work-proyecto"), { recursive: true });
    await mkdir(join(cuentaProceso, "projects", "-work-proyecto"), { recursive: true });
    await mkdir(paseo);
    await writeFile(join(cuentaProveedor, "projects", "-work-proyecto", "solo-proveedor.jsonl"), "{}\n");
    await writeFile(join(cuentaProceso, "projects", "-work-proyecto", "solo-proceso.jsonl"), "{}\n");
    const consulta = (disco: DiscoTranscripts) =>
      comprobarTranscripts(disco, [
        { provider: "claude", sessionId: "solo-proveedor", cwd: "/work/proyecto" },
        { provider: "claude", sessionId: "solo-proceso", cwd: "/work/proyecto" },
      ]).then((r) => r.map((x) => x.existe));
    const disco: DiscoTranscripts = { ...discoReal, env: { PASEO_HOME: paseo, CLAUDE_CONFIG_DIR: cuentaProceso } };

    await writeFile(join(paseo, "config.json"), configConEntorno({ CLAUDE_CONFIG_DIR: cuentaProveedor }));
    assert.deepEqual(await consulta(disco), [true, false], "provider env first");
    await writeFile(join(paseo, "config.json"), "{ esto no es json");
    assert.deepEqual(await consulta(disco), [false, true], "unparseable config: the process env");
    await rm(join(paseo, "config.json"));
    assert.deepEqual(await consulta(disco), [false, true], "no config: the process env");
  } finally {
    await rm(raiz, { recursive: true, force: true });
  }
});
