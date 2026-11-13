import "dotenv/config";
import { createBaseServer } from "../utils/backend/base_backend/create";
import { createAudioExtractorRouter } from "./app";
import { loadBackendConfig } from "./config";
import { TempAudioStore } from "./store";

async function main() {
  const config = loadBackendConfig();
  const store = new TempAudioStore(config.tempDir, config.audioTtlMs);
  await store.init();

  const router = createAudioExtractorRouter({ config, store });
  const server = createBaseServer(router);
  server.start(config.port);

  const cleanup = () => {
    void store.shutdown();
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start Audio Extractor backend:", err);
  process.exit(1);
});
