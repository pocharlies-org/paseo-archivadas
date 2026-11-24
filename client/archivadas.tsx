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
import {
  archivadasList,
  archivadasRestore,
  type BusquedaOut,
  MAX_COMPROBACIONES,
  MAX_CONSULTA,
  MAX_WORKSPACES,
  MIN_CONSULTA,
  type Sesion,
  transcriptsBuscar,
  transcriptsCheck,
} from "../shared/contract.ts";
import {
  aBuscarEnTranscripts,
  buscar,
  type Coincidencia,
  conHistorial,
  conTranscripts,
  enTandas,
  etiquetaArchivada,
  filtrar,
  hace,
  porComprobar,
  RANGOS,
  type Rango,
  restaurable,
  subtituloDe,
} from "../shared/sesiones.ts";
import { type DatosWorkspace, destinoDe, vigilaWorkspaces } from "./workspaces.ts";

type Tema = PluginHostProps["theme"];

/** The header button's id: the host allows lowercase letters, digits and dashes. */
const ID_BOTON = "archivadas";
const ID_PANTALLA_ABRIR = "abrir";
const ID_PANEL = "archivadas";
/** Rows drawn at once: a host with hundreds of sessions would otherwise draw them all every time the popover opens. */
const FILAS_POR_TANDA = 60;
/** Height of a one-line note under the list (11 px text plus the gap). */
const ALTO_NOTA = 22;
/** Pause in the typing after which a transcript search runs (Enter runs it at once): never one search per keystroke. */
const ESPERA_BUSQUEDA_MS = 400;

/** How each time range reads on its chip. `todo` keeps archived sessions older than 30 days reachable. */
const ETIQUETA_RANGO: Record<Rango, string> = { "1h": "1 h", "24h": "24 h", "7d": "7 d", "30d": "30 d", todo: "todo" };
type ArchivadasFiltro = "todas" | "archivadas" | "no";
const ETIQUETA_ARCHIVADAS: Record<ArchivadasFiltro, string> = { todas: "todas", archivadas: "archivadas", no: "no archivadas" };

type Estado =
  | { readonly fase: "cargando" }
  | { readonly fase: "error"; readonly mensaje: string }
  | { readonly fase: "listo"; readonly sesiones: readonly Sesion[]; readonly avisos: readonly string[] };

/** A search inside the transcripts, for the query it was run with. */
type Busqueda =
  | { readonly fase: "inactiva" }
  | { readonly fase: "buscando"; readonly consulta: string }
  | { readonly fase: "error"; readonly consulta: string; readonly mensaje: string }
  | { readonly fase: "lista"; readonly consulta: string; readonly resultados: readonly BusquedaOut[] };

const SIN_LISTA: readonly Sesion[] = [];

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
    const [enTranscripts, setEnTranscripts] = useState(false);
    // The header's filters (SC-6418): time range (24 h by default), archived state, workspace substring and whole-transcript search.
    const [rango, setRango] = useState<Rango>("24h");
    const [archivadasFiltro, setArchivadasFiltro] = useState<ArchivadasFiltro>("todas");
    const [wsTexto, setWsTexto] = useState("");
    const [completo, setCompleto] = useState(false);
    // The query a transcript search runs with: set after a pause in the typing or on Enter, so the search does not follow
    // every keystroke. Null when not searching transcripts.
    const [consulta, setConsulta] = useState<string | null>(null);
    const [busqueda, setBusqueda] = useState<Busqueda>({ fase: "inactiva" });
    const [visibles, setVisibles] = useState(FILAS_POR_TANDA);
    const [intento, setIntento] = useState(0);
    const { height } = useWindowDimensions();

    useEffect(() => {
      let cancelado = false;
      setEstado({ fase: "cargando" });
      void (async () => {
        try {
          // A panel restored with the page can mount before the workspace subscription has answered: ask the host then.
          const entradas = [...datos.entries()].map(([id, d]) => [id, d as DatosWorkspace | null] as const);
          const workspaces = entradas.length > 0 ? entradas : ([[workspaceId, await resuelveWorkspace(workspaceId)]] as const);
          if (workspaces.every(([, d]) => d === null)) throw new Error("Este workspace ya no existe");
          // shortcut: one call covers at most MAX_WORKSPACES workspaces; past that the list is partial and says so.
          const validos = workspaces.filter(([, d]) => d !== null) as readonly (readonly [string, DatosWorkspace])[];
          const cortados = validos.length > MAX_WORKSPACES;
          const { sesiones, avisos: avisosServidor } = await client.rpc(archivadasList, {
            workspaces: validos.slice(0, MAX_WORKSPACES).map(([id, d]) => ({ workspaceId: id, cwd: d.cwd, projectKey: d.projectKey })),
          });
          const avisos = cortados ? [...avisosServidor, `más de ${MAX_WORKSPACES} workspaces: solo se lista una parte`] : avisosServidor;
          // The list is shown once it knows which archived rows still have their history: no row flips from yellow to dim.
          const pendientes = porComprobar(sesiones);
          let conTodo: readonly Sesion[] = sesiones;
          if (pendientes.length > 0) {
            // A failed lookup leaves the rows as restorable: the daemon refuses and rolls back what it cannot resume. The server
            // takes a bounded number of sessions per call, so a long list goes in batches.
            const respuestas = await Promise.all(
              enTandas(pendientes, MAX_COMPROBACIONES).map((tanda) =>
                client.rpc(transcriptsCheck, { sesiones: tanda }).catch(() => ({ resultados: [] })),
              ),
            );
            conTodo = conHistorial(sesiones, respuestas.flatMap((r) => r.resultados));
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
            workspaceId: sesion.workspaceId,
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
      [alTerminar, abre, enPanel],
    );

    const todas = estado.fase === "listo" ? estado.sesiones : SIN_LISTA;

    useEffect(() => {
      if (!enTranscripts) {
        setConsulta(null);
        return;
      }
      const espera = setTimeout(() => setConsulta(texto.trim()), ESPERA_BUSQUEDA_MS);
      return () => clearTimeout(espera);
    }, [texto, enTranscripts]);

    // The list the filters leave: what the text search, the transcript search and the rows read from.
    const base = useMemo(
      () => filtrar(todas, { rango, archivadas: archivadasFiltro, workspace: wsTexto, nombre: (id) => datos.get(id)?.nombre ?? id }),
      [todas, rango, archivadasFiltro, wsTexto],
    );

    // One search per query (and per filtered list): a newer query cancels this one's answer, which is then dropped.
    useEffect(() => {
      if (!enTranscripts || consulta === null || consulta.length < MIN_CONSULTA || base.length === 0) {
        setBusqueda({ fase: "inactiva" });
        return;
      }
      let cancelado = false;
      setBusqueda({ fase: "buscando", consulta });
      void (async () => {
        try {
          // The server takes a bounded number of sessions per call, and each call reads files for up to its time budget: the
          // batches go one after the other, not all at once.
          const resultados: BusquedaOut[] = [];
          for (const tanda of enTandas(aBuscarEnTranscripts(base), MAX_COMPROBACIONES)) {
            if (cancelado) return;
            resultados.push(...(await client.rpc(transcriptsBuscar, { query: consulta, sesiones: tanda, completo })).resultados);
          }
          if (!cancelado) setBusqueda({ fase: "lista", consulta, resultados });
        } catch (error) {
          if (!cancelado) setBusqueda({ fase: "error", consulta, mensaje: mensajeDe(error) });
        }
      })();
      return () => {
        cancelado = true;
      };
    }, [consulta, enTranscripts, completo, base]);

    const enviaBusqueda = () => {
      if (enTranscripts) setConsulta(texto.trim());
    };
    const cambiaModo = () => {
      setEnTranscripts((activo) => !activo);
      setVisibles(FILAS_POR_TANDA);
    };

    const transcripts = useMemo(() => (busqueda.fase === "lista" ? conTranscripts(base, busqueda.resultados) : null), [busqueda, base]);
    const porTexto = useMemo(() => buscar(base, texto), [base, texto]);
    const filtradas = enTranscripts ? (transcripts?.filas ?? SIN_LISTA) : porTexto;
    const archivadas = filtradas.filter((s) => s.archivada).length;
    const cuenta = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
    const resumenCuenta = [
      filtradas.length === todas.length ? cuenta(todas.length, "sesión", "sesiones") : `${filtradas.length} de ${cuenta(todas.length, "sesión", "sesiones")}`,
      archivadas > 0 ? cuenta(archivadas, "archivada", "archivadas") : "",
    ]
      .filter(Boolean)
      .join(" · ");

    // The notes under a transcript search take room the popover does not have: the list gives it up, so the popover keeps its height.
    const notas = enTranscripts && transcripts ? Number(transcripts.noBuscables > 0) + Number(transcripts.parcial) : 0;

    return (
      <View style={enPanel ? { flex: 1, padding: 12, gap: 8 } : { width: layout.compact ? "100%" : 372, gap: 8 }}>
        <Buscador
          theme={theme}
          texto={texto}
          onChange={(t) => (setTexto(t), setVisibles(FILAS_POR_TANDA))}
          enTranscripts={enTranscripts}
          onCambiaModo={cambiaModo}
          onEnvia={enviaBusqueda}
        />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
          {RANGOS.map((r) => (
            <Chip key={r} theme={theme} activo={rango === r} onPress={() => setRango(r)}>
              {ETIQUETA_RANGO[r]}
            </Chip>
          ))}
          {(["todas", "archivadas", "no"] as const).map((a) => (
            <Chip key={a} theme={theme} activo={archivadasFiltro === a} onPress={() => setArchivadasFiltro(a)}>
              {ETIQUETA_ARCHIVADAS[a]}
            </Chip>
          ))}
          <TextInput
            value={wsTexto}
            onChangeText={setWsTexto}
            placeholder="workspace…"
            placeholderTextColor={colores.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={MAX_CONSULTA}
            accessibilityLabel="Filtrar por workspace"
            style={[
              { flex: 1, minWidth: 96, color: colores.foreground, fontSize: 11, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: colores.border, borderRadius: 6, backgroundColor: colores.surface0 },
              { outlineStyle: "none" } as object,
            ]}
          />
          {enTranscripts ? (
            <Chip theme={theme} activo={completo} onPress={() => setCompleto((v) => !v)}>
              transcript entero
            </Chip>
          ) : null}
        </View>
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
        ) : enTranscripts && texto.trim().length < MIN_CONSULTA ? (
          <Aviso theme={theme}>{`Escribe al menos ${MIN_CONSULTA} caracteres para buscar en los transcripts`}</Aviso>
        ) : enTranscripts && (busqueda.fase === "buscando" || (busqueda.fase === "inactiva" && base.length > 0)) ? (
          <Aviso theme={theme} cargando>
            Buscando en transcripts…
          </Aviso>
        ) : enTranscripts && busqueda.fase === "error" ? (
          <View style={{ gap: 8, paddingVertical: 8 }}>
            <Text style={{ color: colores.statusDanger, fontSize: 13 }}>{busqueda.mensaje}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setIntento((n) => n + 1)}
              style={{ alignSelf: "flex-start", borderWidth: 1, borderColor: colores.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}
            >
              <Text style={{ color: colores.foreground, fontSize: 13 }}>Reintentar</Text>
            </Pressable>
          </View>
        ) : filtradas.length === 0 ? (
          <Aviso theme={theme}>
            {todas.length === 0
              ? "No hay sesiones"
              : enTranscripts
                ? `Ningún transcript contiene «${busqueda.fase === "lista" ? busqueda.consulta : texto.trim()}»`
                : texto.trim()
                  ? `Nada coincide con «${texto.trim()}»`
                  : "Nada coincide con los filtros"}
          </Aviso>
        ) : (
          <>
            <Text style={{ color: colores.foregroundMuted, fontSize: 11, paddingHorizontal: 2 }}>{resumenCuenta}</Text>
            <ScrollView style={enPanel ? { flex: 1 } : { maxHeight: alto - notas * ALTO_NOTA }} contentContainerStyle={{ gap: 4 }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
              {filtradas.slice(0, visibles).map((sesion) => (
                <Fila
                  key={sesion.clave}
                  theme={theme}
                  sesion={sesion}
                  restaurando={restaurando === sesion.clave}
                  bloqueada={restaurando !== null}
                  error={errores[sesion.clave] || null}
                  coincidencia={enTranscripts ? (transcripts?.coincidencias.get(sesion.clave) ?? null) : null}
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
        {enTranscripts && transcripts && transcripts.noBuscables > 0 ? (
          <Text numberOfLines={1} style={{ color: colores.foregroundMuted, fontSize: 11 }}>
            {`${cuenta(transcripts.noBuscables, "sesión", "sesiones")} de otros providers no se pueden buscar`}
          </Text>
        ) : null}
        {enTranscripts && transcripts?.parcial ? (
          <Text numberOfLines={1} style={{ color: colores.statusWarning, fontSize: 11 }}>
            Búsqueda parcial: algunos transcripts no se leyeron enteros
          </Text>
        ) : null}
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

interface BuscadorProps {
  readonly theme: Tema;
  readonly texto: string;
  onChange(texto: string): void;
  /** Searching inside the transcripts instead of the titles and prompts. */
  readonly enTranscripts: boolean;
  onCambiaModo(): void;
  /** Enter: a transcript search runs at once instead of after the pause. */
  onEnvia(): void;
}

function Buscador({ theme, texto, onChange, enTranscripts, onCambiaModo, onEnvia }: BuscadorProps) {
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
        onSubmitEditing={onEnvia}
        returnKeyType="search"
        placeholder={enTranscripts ? "Buscar en transcripts…" : "Buscar…"}
        placeholderTextColor={colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={MAX_CONSULTA}
        accessibilityLabel={enTranscripts ? "Buscar en los transcripts" : "Buscar sesiones"}
        // The web focus ring is the host's to draw; a second one inside the popover reads as a glitch.
        style={[{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: 13, paddingVertical: 8 }, { outlineStyle: "none" } as object]}
      />
      {texto ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Borrar la búsqueda" hitSlop={8} onPress={() => onChange("")}>
          <Icon name="X" size={14} color={colors.foregroundMuted} />
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Buscar dentro de los transcripts"
        accessibilityState={{ selected: enTranscripts }}
        hitSlop={6}
        onPress={onCambiaModo}
        style={(estado) => ({
          marginRight: -6,
          padding: 4,
          borderRadius: 6,
          backgroundColor: enTranscripts
            ? (conAlfa(colors.accent, 0.16) ?? colors.surface2)
            : estado.pressed || (estado as { hovered?: boolean }).hovered
              ? colors.surface1
              : "transparent",
        })}
      >
        <Icon name="TextSearch" size={14} color={enTranscripts ? colors.accent : colors.foregroundMuted} />
      </Pressable>
    </View>
  );
}

function Chip({ theme, activo, onPress, children }: { theme: Tema; activo: boolean; onPress(): void; children: string }) {
  const { colors } = theme;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: activo }}
      onPress={onPress}
      style={{
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: activo ? colors.accent : colors.border,
        backgroundColor: activo ? (conAlfa(colors.accent, 0.16) ?? colors.surface2) : "transparent",
      }}
    >
      <Text style={{ color: activo ? colors.accent : colors.foregroundMuted, fontSize: 11 }}>{children}</Text>
    </Pressable>
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
  /** What a transcript search found in this session: drawn under the subtitle. */
  readonly coincidencia?: Coincidencia | null;
  onPress(): void;
}

function Fila({ theme, sesion, restaurando, bloqueada, error, coincidencia, onPress }: FilaProps) {
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
          {coincidencia?.fragmento ? (
            <Text numberOfLines={2} style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 15 }}>
              {coincidencia.fragmento}
            </Text>
          ) : null}
          {coincidencia ? (
            <Text numberOfLines={1} style={{ color: colors.accent, fontSize: 11 }}>
              {`${coincidencia.coincidencias} ${coincidencia.coincidencias === 1 ? "coincidencia" : "coincidencias"}`}
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
