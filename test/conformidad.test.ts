import assert from "node:assert/strict";
import { test } from "node:test";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ClaseCliente, ConexionDaemon } from "../server/daemon.ts";

// Not part of the plugin bundle: only here, where `@getpaseo/client` is installed, may the daemon's own client be named. The
// assignments below fail `npm run typecheck` when that client stops fitting the shape the plugin declares for itself.
type ElCliente = typeof DaemonClient;
const declaradaEncajaEnElCliente = (cliente: InstanceType<ElCliente>): ConexionDaemon => cliente;
const laClaseEncaja = (clase: ElCliente): ClaseCliente => clase;

test("the daemon's own client still fits the shape the plugin declares for itself (checked by tsc)", () => {
  assert.equal(typeof declaradaEncajaEnElCliente, "function");
  assert.equal(typeof laClaseEncaja, "function");
});
