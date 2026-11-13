import assert from "node:assert/strict";
import { test } from "node:test";
import {
  archivadasList,
  archivadasRestore,
  MAX_COMPROBACIONES,
  MAX_CONSULTA,
  MAX_FRAGMENTO,
  MAX_ID,
  MAX_RUTA,
  transcriptsBuscar,
  transcriptsCheck,
} from "../shared/contract.ts";
import { enTandas } from "../shared/sesiones.ts";

const acepta = (esquema: { safeParse(valor: unknown): { success: boolean } }, valor: unknown) => esquema.safeParse(valor).success;
const id = (largo: number) => "i".repeat(largo);
const ruta = (largo: number) => `/${"c".repeat(largo - 1)}`;

const lista = { workspaceId: "wks_a", cwd: "/work/proyecto", projectKey: "prj_1" };
const restaura = { providerId: "claude", providerHandleId: "s-1", cwd: "/work/proyecto", workspaceId: "wks_a" };
const comprobacion = { provider: "claude", sessionId: "s-1", cwd: "/work/proyecto" };

test("archivadas.list: ids up to 200 and a path up to 4096 are taken, one more is not", () => {
  assert.equal(acepta(archivadasList.input, lista), true);
  assert.equal(acepta(archivadasList.input, { ...lista, projectKey: null }), true, "a workspace with no project");
  assert.equal(acepta(archivadasList.input, { workspaceId: id(MAX_ID), cwd: ruta(MAX_RUTA), projectKey: id(MAX_ID) }), true, "at the limits");
  assert.equal(acepta(archivadasList.input, { ...lista, workspaceId: id(MAX_ID + 1) }), false, "workspaceId");
  assert.equal(acepta(archivadasList.input, { ...lista, projectKey: id(MAX_ID + 1) }), false, "projectKey");
  assert.equal(acepta(archivadasList.input, { ...lista, cwd: ruta(MAX_RUTA + 1) }), false, "cwd");
  assert.equal(acepta(archivadasList.input, { ...lista, de_mas: 1 }), false, "still strict");
});

test("archivadas.restaurar: ids up to 200 and a path up to 4096 are taken, one more is not", () => {
  assert.equal(acepta(archivadasRestore.input, restaura), true);
  assert.equal(acepta(archivadasRestore.input, { providerId: id(MAX_ID), providerHandleId: id(MAX_ID), cwd: ruta(MAX_RUTA), workspaceId: id(MAX_ID) }), true, "at the limits");
  for (const campo of ["providerId", "providerHandleId", "workspaceId"] as const) {
    assert.equal(acepta(archivadasRestore.input, { ...restaura, [campo]: id(MAX_ID + 1) }), false, campo);
  }
  assert.equal(acepta(archivadasRestore.input, { ...restaura, cwd: ruta(MAX_RUTA + 1) }), false, "cwd");
  assert.equal(acepta(archivadasRestore.input, { ...restaura, de_mas: 1 }), false, "still strict");
});

test("archivadas.transcripts: at most 500 sessions per call, with bounded strings", () => {
  const tanda = (n: number) => ({ sesiones: Array.from({ length: n }, () => comprobacion) });
  assert.equal(acepta(transcriptsCheck.input, tanda(0)), true);
  assert.equal(acepta(transcriptsCheck.input, tanda(MAX_COMPROBACIONES)), true, "500 is the limit");
  assert.equal(acepta(transcriptsCheck.input, tanda(MAX_COMPROBACIONES + 1)), false, "501 is rejected");
  assert.equal(acepta(transcriptsCheck.input, tanda(100_000)), false);
  assert.equal(acepta(transcriptsCheck.input, { sesiones: [{ ...comprobacion, provider: id(MAX_ID + 1) }] }), false, "provider");
  assert.equal(acepta(transcriptsCheck.input, { sesiones: [{ ...comprobacion, sessionId: id(MAX_ID + 1) }] }), false, "sessionId");
  assert.equal(acepta(transcriptsCheck.input, { sesiones: [{ ...comprobacion, cwd: ruta(MAX_RUTA + 1) }] }), false, "cwd");
  assert.equal(acepta(transcriptsCheck.input, { sesiones: [{ provider: id(MAX_ID), sessionId: id(MAX_ID), cwd: ruta(MAX_RUTA) }] }), true, "at the limits");
  const resultado = { provider: "claude", sessionId: "s-1", existe: true };
  assert.equal(acepta(transcriptsCheck.output, { resultados: Array.from({ length: MAX_COMPROBACIONES }, () => resultado) }), true);
  assert.equal(acepta(transcriptsCheck.output, { resultados: Array.from({ length: MAX_COMPROBACIONES + 1 }, () => resultado) }), false, "an answer per session asked, no more");
});

test("archivadas.buscar-transcripts: a query of 2 to 500 characters, at most 500 sessions, strict, and a bounded answer", () => {
  const busca = (query: string, n = 1) => ({ query, sesiones: Array.from({ length: n }, () => comprobacion) });
  assert.equal(acepta(transcriptsBuscar.input, busca("ab")), true);
  assert.equal(acepta(transcriptsBuscar.input, busca("x".repeat(MAX_CONSULTA))), true, "500 is the limit");
  assert.equal(acepta(transcriptsBuscar.input, busca("x".repeat(MAX_CONSULTA + 1))), false, "501 is rejected");
  assert.equal(acepta(transcriptsBuscar.input, busca("a")), false, "one character");
  assert.equal(acepta(transcriptsBuscar.input, busca("  a   ")), false, "two characters only with the spaces");
  assert.equal(acepta(transcriptsBuscar.input, busca("ab", MAX_COMPROBACIONES)), true);
  assert.equal(acepta(transcriptsBuscar.input, busca("ab", MAX_COMPROBACIONES + 1)), false, "501 sessions");
  assert.equal(acepta(transcriptsBuscar.input, { ...busca("ab"), de_mas: 1 }), false, "strict");
  assert.equal(acepta(transcriptsBuscar.input, { query: "ab", sesiones: [{ ...comprobacion, sessionId: id(MAX_ID + 1) }] }), false, "sessionId");
  assert.equal(acepta(transcriptsBuscar.input, { query: "ab", sesiones: [{ ...comprobacion, cwd: ruta(MAX_RUTA + 1) }] }), false, "cwd");
  assert.equal(acepta(transcriptsBuscar.input, { query: "ab", sesiones: [{ ...comprobacion, de_mas: 1 }] }), false, "each session strict");
  const resultado = { provider: "claude", sessionId: "s-1", buscable: true, coincidencias: 3, fragmento: "…algo…", parcial: false };
  assert.equal(acepta(transcriptsBuscar.output, { resultados: Array.from({ length: MAX_COMPROBACIONES }, () => resultado) }), true);
  assert.equal(acepta(transcriptsBuscar.output, { resultados: Array.from({ length: MAX_COMPROBACIONES + 1 }, () => resultado) }), false, "an answer per session asked");
  assert.equal(acepta(transcriptsBuscar.output, { resultados: [{ ...resultado, fragmento: null }] }), true);
  assert.equal(acepta(transcriptsBuscar.output, { resultados: [{ ...resultado, fragmento: "x".repeat(MAX_FRAGMENTO + 1) }] }), false, "fragment");
  assert.equal(acepta(transcriptsBuscar.output, { resultados: [{ ...resultado, coincidencias: -1 }] }), false, "count");
});

test("enTandas: the lookups of a long list fit the bound, in order, with nothing lost", () => {
  const todas = Array.from({ length: 1203 }, (_, n) => ({ ...comprobacion, sessionId: `s-${n}` }));
  const tandas = enTandas(todas, MAX_COMPROBACIONES);
  assert.deepEqual(tandas.map((t) => t.length), [500, 500, 203]);
  assert.deepEqual(tandas.flat(), todas);
  for (const sesiones of tandas) assert.equal(acepta(transcriptsCheck.input, { sesiones }), true);
  assert.deepEqual(enTandas([], MAX_COMPROBACIONES), []);
  assert.deepEqual(enTandas([1, 2, 3], 3), [[1, 2, 3]]);
  assert.deepEqual(enTandas([1, 2, 3, 4], 3), [[1, 2, 3], [4]]);
});
