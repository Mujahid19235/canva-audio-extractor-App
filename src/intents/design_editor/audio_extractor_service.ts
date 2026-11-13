import { getTemporaryUrl, upload } from "@canva/asset";
import type { SelectionEvent } from "@canva/design";
import { addAudioTrack } from "@canva/design";
import { auth } from "@canva/user";

export const MAX_VIDEO_FILE_SIZE_BYTES = 250 * 1024 * 1024; // 250 MB

const SUPPORTED_VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".avi",
  ".mkv",
  ".mpeg",
  ".mpg",
]);

export interface ExtractAudioResponse {
  token: string;
  audioUrl: string;
  mimeType: "audio/mpeg";
  durationMs: number;
  title: string;
}

export type LocalFileValidationError =
  | "empty_file"
  | "file_too_large"
  | "unsupported_type";

export function getDefaultBackendHost(): string {
  return typeof BACKEND_HOST !== "undefined"
    ? BACKEND_HOST
    : "http://localhost:3001";
}

export function validateLocalVideoFile(
  file: File,
): LocalFileValidationError | null {
  if (file.size === 0) {
    return "empty_file";
  }

  if (file.size > MAX_VIDEO_FILE_SIZE_BYTES) {
    return "file_too_large";
  }

  const hasVideoMime = file.type.startsWith("video/");
  const lowerName = file.name.toLowerCase();
  const dotIndex = lowerName.lastIndexOf(".");
  const ext = dotIndex >= 0 ? lowerName.slice(dotIndex) : "";
  const hasVideoExt = SUPPORTED_VIDEO_EXTENSIONS.has(ext);

  if (!hasVideoMime && !hasVideoExt) {
    return "unsupported_type";
  }

  return null;
}

async function parseExtractionResponse(
  res: Response,
): Promise<ExtractAudioResponse> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }

  if (!res.ok) {
    const errorMessage =
      typeof body === "object" &&
      body != null &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Extraction failed (status ${res.status}).`;
    throw new Error(errorMessage);
  }

  const parsed = body as Partial<ExtractAudioResponse> | undefined;
  if (
    !parsed ||
    typeof parsed.audioUrl !== "string" ||
    typeof parsed.token !== "string" ||
    typeof parsed.durationMs !== "number"
  ) {
    throw new Error("Invalid response from audio extraction server.");
  }

  return {
    token: parsed.token,
    audioUrl: parsed.audioUrl,
    mimeType: "audio/mpeg",
    durationMs: parsed.durationMs,
    title: typeof parsed.title === "string" ? parsed.title : "Extracted audio",
  };
}

export async function extractAudioFromCanvasSelection(
  selection: SelectionEvent<"video">,
  backendHost = getDefaultBackendHost(),
): Promise<ExtractAudioResponse> {
  const draft = await selection.read();
  const firstVideo = draft.contents[0];
  if (!firstVideo) {
    throw new Error("No video is currently selected on the canvas.");
  }

  const { url: temporaryVideoUrl } = await getTemporaryUrl({
    type: "video",
    ref: firstVideo.ref,
  });

  const userToken = await auth.getCanvaUserToken();
  const response = await fetch(`${backendHost}/api/extract`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      videoUrl: temporaryVideoUrl,
      title: "Extracted audio",
    }),
  });

  return parseExtractionResponse(response);
}

export async function extractAudioFromLocalFile(
  file: File,
  backendHost = getDefaultBackendHost(),
): Promise<ExtractAudioResponse> {
  const userToken = await auth.getCanvaUserToken();
  const formData = new FormData();
  formData.append("video", file);
  formData.append("title", file.name);

  const response = await fetch(`${backendHost}/api/extract`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${userToken}`,
    },
    body: formData,
  });

  return parseExtractionResponse(response);
}

export async function cleanupExtractedAudio(
  token: string,
  backendHost = getDefaultBackendHost(),
): Promise<void> {
  try {
    const userToken = await auth.getCanvaUserToken();
    await fetch(`${backendHost}/api/audio/${encodeURIComponent(token)}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${userToken}`,
      },
    });
  } catch {
    // Best-effort cleanup; backend TTL sweeper also removes expired files
  }
}

export async function uploadAndInsertAudio(params: {
  audioUrl: string;
  durationMs: number;
  title: string;
  canAddAudioTrack: boolean;
}): Promise<{ addedToTimeline: boolean }> {
  const queuedAudio = await upload({
    type: "audio",
    mimeType: "audio/mpeg",
    url: params.audioUrl,
    durationMs: params.durationMs,
    title: params.title,
    aiDisclosure: "none",
  });

  await queuedAudio.whenUploaded();

  if (params.canAddAudioTrack) {
    await addAudioTrack({
      ref: queuedAudio.ref,
    });
    return { addedToTimeline: true };
  }

  return { addedToTimeline: false };
}
