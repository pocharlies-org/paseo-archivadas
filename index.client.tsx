import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeArchivadas } from "./client/archivadas.tsx";

export default function contribute(client: PluginClientContext) {
  return contributeArchivadas(client);
}
