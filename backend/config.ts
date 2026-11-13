import os from "node:os";
import path from "node:path";

export interface BackendConfig {
  canvaAppId: string;
  canvaAppOrigin?: string;
  port: number | string;
  publicBackendUrl?: string;
  maxFileSizeBytes: number;
  extractionTimeoutMs: number;
  fetchTimeoutMs: number;
  audioTtlMs: number;
  tempDir: string;
}

const DEFAULT_MAX_FILE_SIZE_BYTES = 250 * 1024 * 1024; // 250 MB (Canva upload limit)
const DEFAULT_EXTRACTION_TIMEOUT_MS = 120_000; // 2 minutes
const DEFAULT_FETCH_TIMEOUT_MS = 60_000; // 1 minute
const DEFAULT_AUDIO_TTL_MS = 5 * 60 * 1000; // 5 minutes

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadBackendConfig(): BackendConfig {
  const canvaAppId = process.env.CANVA_APP_ID?.trim();
  if (!canvaAppId) {
    throw new Error(
      "CANVA_APP_ID environment variable is required. Set it in your .env file.",
    );
  }

  return {
    canvaAppId,
    canvaAppOrigin: process.env.CANVA_APP_ORIGIN?.trim() || undefined,
    port: process.env.CANVA_BACKEND_PORT || 3001,
    publicBackendUrl:
      process.env.CANVA_PUBLIC_BACKEND_URL?.trim() ||
      process.env.CANVA_BACKEND_HOST?.trim() ||
      undefined,
    maxFileSizeBytes: parsePositiveInt(
      process.env.MAX_FILE_SIZE_BYTES,
      DEFAULT_MAX_FILE_SIZE_BYTES,
    ),
    extractionTimeoutMs: parsePositiveInt(
      process.env.EXTRACTION_TIMEOUT_MS,
      DEFAULT_EXTRACTION_TIMEOUT_MS,
    ),
    fetchTimeoutMs: parsePositiveInt(
      process.env.FETCH_TIMEOUT_MS,
      DEFAULT_FETCH_TIMEOUT_MS,
    ),
    audioTtlMs: parsePositiveInt(
      process.env.AUDIO_TTL_MS,
      DEFAULT_AUDIO_TTL_MS,
    ),
    tempDir:
      process.env.AUDIO_EXTRACTOR_TEMP_DIR?.trim() ||
      path.join(os.tmpdir(), "canva-audio-extractor"),
  };
}
