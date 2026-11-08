import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
  PluginHostProps,
  PluginScreenProps,
  PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, useWindowDimensions, View } from "react-native";
import { conAlfa } from "../shared/color.ts";
import { archivadasList, archivadasRestore, type Sesion, transcriptsCheck } from "../shared/contract.ts";
import { buscar, conHistorial, etiquetaArchivada, hace, porComprobar, restaurable, subtituloDe } from "../shared/sesiones.ts";

type Tema = PluginHostProps["theme"];

/** The header button's id: the host allows lowercase letters, digits and dashes. */
const ID_BOTON = "archivadas";
const ID_PANTALLA_ABRIR = "abrir";
const ID_PANEL = "archivadas";
/** Rows drawn at once: a host with hundreds of sessions would otherwise draw them all every time the popover opens. */
const FILAS_POR_TANDA = 60;

interface DatosWorkspace {
  readonly cwd: string;
  readonly projectKey: string | null;
}

type Estado =
  | { readonly fase: "cargando" }
  | { readonly fase: "error"; readonly mensaje: string }
  | { readonly fase: "listo"; readonly sesiones: readonly Sesion[]; readonly avisos: readonly string[] };

const mensajeDe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function contributeArchivadas(client: PluginClientContext): () => void {
  const lifetime = new AbortController();
  const datos = new Map<string, DatosWorkspace>();
  const botones = new Map<string, PluginButtonRegistration>();

  const resuelveWorkspace = async (workspaceId: string): Promise<DatosWorkspace | null> => {
    const w = await client.paseo.workspaces.ref(workspaceId).refresh();
    return w && !w.archivingAt ? destinoDe(w) : null;
  };

  // One button per workspace the host lists: added when it appears, removed when it goes (or starts archiving).
  const sincroniza = () => {
    if (lifetime.signal.aborted) return;
    for (const id of datos.keys()) {
      if (botones.has(id)) continue;
      botones.set(
        id,
        client.addHeaderButton({
          id: ID_BOTON,
          workspaceId: id,
          button: { title: "Sesiones y archivadas", icon: "Archive", behavior: { kind: "popover", Content: Lista } },
        }),
      );
    }
    for (const [id, boton] of botones) {
      if (datos.has(id)) continue;
      boton.remove();
      botones.delete(id);
    }
  };

  // The popover has no navigation (only screens and panels get `navigation.openAgent`): the row opens this screen, which
  // opens the agent. Paseo's workspace navigation pops back to the host route, so the screen does not stay in the history.
  function AbrirAgente({ params, navigation, theme }: PluginScreenProps) {
    const agentId = params.agentId;
    useEffect(() => {
      if (agentId) navigation?.openAgent({ agentId });
    }, [agentId, navigation]);
    if (navigation) return null;
    return <Text style={{ color: theme.colors.foregroundMuted, padding: 24 }}>Esta versión de Paseo no deja abrir un agente desde un plugin.</Text>;
  }

  // The same list in the header button's popover (desktop) and in a workspace panel (what the phone has: Paseo 0.12 draws no
  // plugin header buttons in its compact header).
  function Lista({ theme, layout, workspaceId, close }: PluginButtonContentProps) {
    return <ListaDeSesiones theme={theme} layout={layout} workspaceId={workspaceId} abre={abreAgente} alTerminar={close} />;
  }

  const abreAgente = (agentId: string) => client.openScreen({ screenId: ID_PANTALLA_ABRIR, params: { agentId } });

  function PanelArchivadas({ theme, layout, navigation, workspaceId }: PluginWorkspacePanelProps) {
    // A panel gets navigation, so a row opens its agent directly; it stays open, so it reloads after each restore.
    return (
      <ListaDeSesiones
        theme={theme}
        layout={layout}
        workspaceId={workspaceId}
        abre={(agentId) => (navigation ? navigation.openAgent({ agentId }) : abreAgente(agentId))}
        enPanel
      />
    );
  }

  interface ListaProps {
    readonly theme: Tema;
    readonly layout: PluginHostProps["layout"];
    readonly workspaceId: string;
    abre(agentId: string): void;
    /** Called after a restore: the popover closes itself. */
    alTerminar?(): void;
    readonly enPanel?: boolean;
  }

  function ListaDeSesiones({ theme, layout, workspaceId, abre, alTerminar, enPanel }: ListaProps) {
    const [estado, setEstado] = useState<Estado>({ fase: "cargando" });
    const [texto, setTexto] = useState("");
    const [visibles, setVisibles] = useState(FILAS_POR_TANDA);
    const [intento, setIntento] = useState(0);
    const { height } = useWindowDimensions();

    useEffect(() => {
      let cancelado = false;
      setEstado({ fase: "cargando" });
      void (async () => {
        try {
          // A panel restored with the page can mount before the workspace subscription has answered: ask the host then.
          const destino = datos.get(workspaceId) ?? (await resuelveWorkspace(workspaceId));
          if (!destino) throw new Error("Este workspace ya no existe");
          const { sesiones, avisos } = await client.rpc(archivadasList, { workspaceId, cwd: destino.cwd, projectKey: destino.projectKey });
          // The list is shown once it knows which archived rows still have their history: no row flips from yellow to dim.
          const pendientes = porComprobar(sesiones);
          let conTodo: readonly Sesion[] = sesiones;
          if (pendientes.length > 0) {
            // A failed lookup leaves the rows as restorable: the daemon refuses and rolls back what it cannot resume.
            const { resultados } = await client.rpc(transcriptsCheck, { sesiones: pendientes }).catch(() => ({ resultados: [] }));
            conTodo = conHistorial(sesiones, resultados);
          }
          if (!cancelado) setEstado({ fase: "listo", sesiones: conTodo, avisos });
        } catch (error) {
          if (!cancelado) setEstado({ fase: "error", mensaje: mensajeDe(error) });
        }
      })();
      return () => {
        cancelado = true;
      };
    }, [workspaceId, intento]);

    const colores = theme.colors;
    // The host's popover stops at 440 px: search, count and padding take ~130, so the list ends before the surface starts scrolling too.
    const alto = layout.compact ? Math.max(260, Math.round(height * 0.55)) : 300;

    // Row state: which one is being restored, and the error each row shows under itself.
    const [restaurando, setRestaurando] = useState<string | null>(null);
    const [errores, setErrores] = useState<Readonly<Record<string, string>>>({});
    const ocupado = useRef(false);
    const restaura = useCallback(
      async (sesion: Sesion) => {
        // One restore at a time: a second tap while the first is in flight would race the daemon for the same agent.
        if (ocupado.current) return;
        ocupado.current = true;
        setRestaurando(sesion.clave);
        setErrores((previos) => ({ ...previos, [sesion.clave]: "" }));
        try {
          const { agentId } = await client.rpc(archivadasRestore, {
            providerId: sesion.providerId,
            providerHandleId: sesion.providerHandleId,
            cwd: sesion.cwd,
            workspaceId,
          });
          alTerminar?.();
          abre(agentId);
          // A panel stays on screen: what it shows has to match what just happened.
          if (enPanel) setIntento((n) => n + 1);
        } catch (error) {
          setErrores((previos) => ({ ...previos, [sesion.clave]: mensajeDe(error) }));
        } finally {
          ocupado.current = false;
          setRestaurando(null);
        }
      },
      [workspaceId, alTerminar, abre, enPanel],
    );

    const todas = estado.fase === "listo" ? estado.sesiones : [];
    const filtradas = useMemo(() => buscar(todas, texto), [todas, texto]);
    const archivadas = filtradas.filter((s) => s.archivada).length;
    const cuenta = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
    const resumenCuenta = [
      filtradas.length === todas.length ? cuenta(todas.length, "sesión", "sesiones") : `${filtradas.length} de ${cuenta(todas.length, "sesión", "sesiones")}`,
      archivadas > 0 ? cuenta(archivadas, "archivada", "archivadas") : "",
    ]
      .filter(Boolean)
      .join(" · ");

    return (
      <View style={enPanel ? { flex: 1, padding: 12, gap: 8 } : { width: layout.compact ? "100%" : 372, gap: 8 }}>
        <Buscador theme={theme} texto={texto} onChange={(t) => (setTexto(t), setVisibles(FILAS_POR_TANDA))} />
        {estado.fase === "cargando" ? (
          <Aviso theme={theme} cargando>
            Cargando sesiones…
          </Aviso>
        ) : estado.fase === "error" ? (
          <View style={{ gap: 8, paddingVertical: 8 }}>
            <Text style={{ color: colores.statusDanger, fontSize: 13 }}>{estado.mensaje}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setIntento((n) => n + 1)}
              style={{ alignSelf: "flex-start", borderWidth: 1, borderColor: colores.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}
            >
              <Text style={{ color: colores.foreground, fontSize: 13 }}>Reintentar</Text>
            </Pressable>
          </View>
        ) : filtradas.length === 0 ? (
          <Aviso theme={theme}>{todas.length === 0 ? "No hay sesiones en este workspace" : `Nada coincide con «${texto.trim()}»`}</Aviso>
        ) : (
          <>
            <Text style={{ color: colores.foregroundMuted, fontSize: 11, paddingHorizontal: 2 }}>{resumenCuenta}</Text>
            <ScrollView style={enPanel ? { flex: 1 } : { maxHeight: alto }} contentContainerStyle={{ gap: 4 }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
              {filtradas.slice(0, visibles).map((sesion) => (
                <Fila
                  key={sesion.clave}
                  theme={theme}
                  sesion={sesion}
                  restaurando={restaurando === sesion.clave}
                  bloqueada={restaurando !== null}
                  error={errores[sesion.clave] || null}
                  onPress={() => void restaura(sesion)}
                />
              ))}
              {filtradas.length > visibles ? (
                <Pressable accessibilityRole="button" onPress={() => setVisibles((n) => n + FILAS_POR_TANDA)} style={{ paddingVertical: 8, alignItems: "center" }}>
                  <Text style={{ color: colores.accent, fontSize: 12 }}>Mostrar más ({filtradas.length - visibles})</Text>
                </Pressable>
              ) : null}
            </ScrollView>
          </>
        )}
        {estado.fase === "listo" && estado.avisos.length > 0 ? (
          <Text numberOfLines={2} style={{ color: colores.statusWarning, fontSize: 11 }}>
            Lista incompleta: {estado.avisos.join("; ")}
          </Text>
        ) : null}
      </View>
    );
  }

  const suelta = vigilaWorkspaces(client, lifetime.signal, datos, sincroniza);
  client.addScreen({ id: ID_PANTALLA_ABRIR, title: "Agente", Component: AbrirAgente });
  client.addWorkspacePanel({ id: ID_PANEL, title: "Sesiones y archivadas", icon: "Archive", context: "workspace", locations: ["workspace"], Component: PanelArchivadas });
  client.addCommandCenterItem({
    id: ID_PANEL,
    title: "Sesiones y archivadas",
    icon: "Archive",
    keywords: ["archivadas", "archivados", "sesiones", "importar", "restaurar", "recuperar"],
    context: "workspace",
    onSelect: (contexto) => contexto.openPanel(ID_PANEL, { location: "workspace" }),
  });
  return () => {
    lifetime.abort();
    suelta();
    for (const boton of botones.values()) boton.remove();
    botones.clear();
  };
}

/** The part of a workspace descriptor the list needs: where its sessions live and which project its agents belong to. */
interface Descriptor {
  readonly id: string;
  readonly projectId: string;
  readonly projectRootPath: string;
  readonly workspaceDirectory?: string;
  readonly archivingAt?: string | null;
}
const destinoDe = (w: Descriptor): DatosWorkspace => ({ cwd: w.workspaceDirectory ?? w.projectRootPath, projectKey: w.projectId || null });

/** Keeps `datos` equal to the workspaces the host lists (directory and project key), and calls `cambio` when it changes. */
function vigilaWorkspaces(client: PluginClientContext, signal: AbortSignal, datos: Map<string, DatosWorkspace>, cambio: () => void): () => void {
  const anota = (w: Descriptor) => {
    if (w.archivingAt) datos.delete(w.id);
    else datos.set(w.id, destinoDe(w));
  };
  let soltar: (() => void) | null = null;
  let suscripcion: { release(): Promise<void> } | null = null;
  type Paginacion = { readonly hasMore: boolean; readonly nextCursor: string | null };
  // The subscription's snapshot is the first page: a host with more workspaces than one page holds reads the rest.
  const leeResto = async (pageInfo: Paginacion) => {
    let siguiente = pageInfo.hasMore ? pageInfo.nextCursor : null;
    while (siguiente && !signal.aborted) {
      const pagina = await client.paseo.workspaces.list({ page: { limit: 200, cursor: siguiente } });
      for (const w of pagina.entries) anota(w);
      siguiente = pagina.pageInfo.hasMore ? pagina.pageInfo.nextCursor : null;
    }
    cambio();
  };
  const falla = (error: unknown) => console.error("paseo-archivadas: no se pudo leer la lista de workspaces", error);
  void client.paseo.workspaces
    .list({ subscribe: {}, page: { limit: 200 } })
    .then(({ subscription, entries, pageInfo }) => {
      if (signal.aborted) return void subscription.release();
      suscripcion = subscription;
      soltar = subscription.subscribe({
        snapshot: ({ entries: todas, pageInfo: paginas }) => {
          datos.clear();
          for (const w of todas) anota(w);
          cambio();
          void leeResto(paginas).catch(falla);
        },
        update: (mensaje) => {
          if (mensaje.type !== "workspace_update") return;
          const cambioDe = mensaje.payload;
          if (cambioDe.kind === "upsert") anota(cambioDe.workspace);
          else datos.delete(cambioDe.id);
          cambio();
        },
      });
      for (const w of entries) anota(w);
      cambio();
      return leeResto(pageInfo);
    })
    .catch(falla);
  return () => {
    soltar?.();
    void suscripcion?.release();
  };
}

function Buscador({ theme, texto, onChange }: { theme: Tema; texto: string; onChange(texto: string): void }) {
  const { colors } = theme;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 8,
        backgroundColor: colors.surface0,
        paddingHorizontal: 10,
      }}
    >
      <Icon name="Search" size={14} color={colors.foregroundMuted} />
      <TextInput
        value={texto}
        onChangeText={onChange}
        placeholder="Buscar…"
        placeholderTextColor={colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Buscar sesiones"
        // The web focus ring is the host's to draw; a second one inside the popover reads as a glitch.
        style={[{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: 13, paddingVertical: 8 }, { outlineStyle: "none" } as object]}
      />
      {texto ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Borrar la búsqueda" hitSlop={8} onPress={() => onChange("")}>
          <Icon name="X" size={14} color={colors.foregroundMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

function Aviso({ theme, cargando, children }: { theme: Tema; cargando?: boolean; children: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 20 }}>
      {cargando ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, textAlign: "center" }}>{children}</Text>
    </View>
  );
}

interface FilaProps {
  readonly theme: Tema;
  readonly sesion: Sesion;
  readonly restaurando: boolean;
  /** Another row is being restored: this one waits. */
  readonly bloqueada: boolean;
  readonly error: string | null;
  onPress(): void;
}

function Fila({ theme, sesion, restaurando, bloqueada, error, onPress }: FilaProps) {
  const { colors } = theme;
  const archivada = sesion.archivada !== null;
  const puede = restaurable(sesion);
  const tono = archivada ? colors.statusWarning : colors.foreground;
  const fondo = archivada ? (conAlfa(colors.statusWarning, 0.1) ?? colors.surface1) : "transparent";
  const fondoActivo = archivada ? (conAlfa(colors.statusWarning, 0.18) ?? colors.surface2) : colors.surface1;
  const etiqueta = etiquetaArchivada(sesion);
  const subtitulo = subtituloDe(sesion);
  const cuando = archivada ? "" : hace(sesion.ultimaActividad);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${etiqueta ? `${etiqueta}. ` : ""}${sesion.titulo}`}
        accessibilityState={{ disabled: !puede || bloqueada, busy: restaurando }}
        disabled={!puede || bloqueada}
        onPress={onPress}
        style={(estado) => [
          {
            flexDirection: "row",
            alignItems: "stretch",
            borderRadius: 8,
            overflow: "hidden",
            backgroundColor: estado.pressed || (estado as { hovered?: boolean }).hovered ? fondoActivo : fondo,
            opacity: !puede ? 0.6 : bloqueada && !restaurando ? 0.5 : 1,
          },
          // «Sin historial» is not an error but a dead end: the same yellow, dimmed and not clickable.
          !puede ? ({ cursor: "default" } as object) : null,
        ]}
      >
        {archivada ? <View style={{ width: 3, backgroundColor: colors.statusWarning }} /> : null}
        <View style={{ flex: 1, minWidth: 0, paddingVertical: 8, paddingHorizontal: 10, gap: 2 }}>
          {etiqueta ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Icon name={puede ? "Archive" : "ArchiveX"} size={11} color={colors.statusWarning} />
              <Text numberOfLines={1} style={{ color: colors.statusWarning, fontSize: 11, fontWeight: "600" }}>
                {etiqueta}
              </Text>
            </View>
          ) : null}
          <Text numberOfLines={2} style={{ color: tono, fontSize: 13, lineHeight: 18 }}>
            {sesion.titulo}
          </Text>
          {subtitulo ? (
            <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11 }}>
              {subtitulo}
            </Text>
          ) : null}
        </View>
        {restaurando ? (
          <View style={{ justifyContent: "center", paddingRight: 10 }}>
            <ActivityIndicator size="small" color={colors.statusWarning} />
          </View>
        ) : cuando ? (
          <View style={{ justifyContent: "center", paddingRight: 10 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{cuando}</Text>
          </View>
        ) : null}
      </Pressable>
      {error ? <Text style={{ color: colors.statusDanger, fontSize: 11, paddingHorizontal: 10, paddingTop: 2, paddingBottom: 4 }}>{error}</Text> : null}
    </View>
  );
}
