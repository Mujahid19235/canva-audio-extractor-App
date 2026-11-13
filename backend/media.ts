import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { ValidationError, validateRemoteVideoUrl } from "./security";

const execFileAsync = promisify(execFile);

export class MediaProcessingError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 422) {
    super(message);
    this.name = "MediaProcessingError";
    this.statusCode = statusCode;
  }
}

interface FfprobeStream {
  codec_type?: string;
  duration?: string;
}

interface FfprobeFormat {
  format_name?: string;
  duration?: string;
}

interface FfprobeResult {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

function ensureExecutable(binaryPath: string): string {
  try {
    fs.accessSync(binaryPath, fs.constants.X_OK);
  } catch {
    try {
      fs.chmodSync(binaryPath, 0o755);
    } catch {
      // Ignore chmod errors; execFile will report if still non-executable
    }
  }
  return binaryPath;
}

function getFfmpegBinary(): string {
  if (ffmpegPath && fs.existsSync(ffmpegPath)) {
    return ensureExecutable(ffmpegPath);
  }
  return "ffmpeg";
}

function getFfprobeBinary(): string {
  if (ffprobeStatic?.path && fs.existsSync(ffprobeStatic.path)) {
    return ensureExecutable(ffprobeStatic.path);
  }
  return "ffprobe";
}

export async function getMediaBinaryStatus(): Promise<{
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  ffmpegRunnable: boolean;
  ffprobeRunnable: boolean;
  ffmpegError?: string;
  ffprobeError?: string;
}> {
  const ffmpegBin = getFfmpegBinary();
  const ffprobeBin = getFfprobeBinary();

  let ffmpegRunnable = false;
  let ffmpegError: string | undefined;
  try {
    await execFileAsync(ffmpegBin, ["-version"], { timeout: 5000 });
    ffmpegRunnable = true;
  } catch (err) {
    ffmpegError = err instanceof Error ? err.message : String(err);
  }

  let ffprobeRunnable = false;
  let ffprobeError: string | undefined;
  try {
    await execFileAsync(ffprobeBin, ["-version"], { timeout: 5000 });
    ffprobeRunnable = true;
  } catch (err) {
    ffprobeError = err instanceof Error ? err.message : String(err);
  }

  return {
    ffmpegAvailable: Boolean(ffmpegPath && fs.existsSync(ffmpegPath)),
    ffprobeAvailable: Boolean(ffprobeStatic?.path && fs.existsSync(ffprobeStatic.path)),
    ffmpegRunnable,
    ffprobeRunnable,
    ffmpegError,
    ffprobeError,
  };
}

export async function probeMedia(
  filePath: string,
  timeoutMs: number,
): Promise<FfprobeResult> {
  const ffprobe = getFfprobeBinary();

  try {
    const { stdout } = await execFileAsync(
      ffprobe,
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        filePath,
      ],
      { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
    );

    return JSON.parse(stdout) as FfprobeResult;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("ffprobe error:", err);
    if (
      err instanceof Error &&
      "killed" in err &&
      (err as { killed?: boolean }).killed
    ) {
      throw new MediaProcessingError(
        "Timed out while inspecting the video file.",
        504,
      );
    }
    const errno = (err as NodeJS.ErrnoException)?.code;
    if (errno === "ENOENT" || errno === "EACCES") {
      throw new MediaProcessingError(
        "Server media inspector is unavailable.",
        500,
      );
    }
    const detail =
      err instanceof Error && err.message ? ` (${err.message.slice(0, 120)})` : "";
    throw new MediaProcessingError(
      `The selected file is not a valid or supported video.${detail}`,
      400,
    );
  }
}

export async function validateVideoHasAudio(
  filePath: string,
  timeoutMs: number,
): Promise<void> {
  const probe = await probeMedia(filePath, timeoutMs);
  const streams = probe.streams ?? [];

  if (streams.length === 0) {
    throw new MediaProcessingError(
      "The selected file does not contain any valid media streams.",
      400,
    );
  }

  const hasAudio = streams.some((stream) => stream.codec_type === "audio");
  if (!hasAudio) {
    throw new MediaProcessingError(
      "This video does not contain an audio track.",
      422,
    );
  }
}

export async function extractAudioToMp3(params: {
  inputPath: string;
  outputPath: string;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<{ durationMs: number; sizeBytes: number }> {
  const { inputPath, outputPath, timeoutMs, maxOutputBytes } = params;
  const ffmpeg = getFfmpegBinary();

  try {
    await execFileAsync(
      ffmpeg,
      [
        "-y",
        "-i",
        inputPath,
        "-vn",
        "-acodec",
        "libmp3lame",
        "-q:a",
        "4",
        outputPath,
      ],
      { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
    );
  } catch (err) {
    if (
      err instanceof Error &&
      "killed" in err &&
      (err as { killed?: boolean }).killed
    ) {
      throw new MediaProcessingError(
        "Audio extraction timed out. Try a shorter or smaller video.",
        504,
      );
    }
    throw new MediaProcessingError(
      "Failed to extract audio from the video.",
      422,
    );
  }

  const stats = await fsp.stat(outputPath);
  if (stats.size === 0) {
    throw new MediaProcessingError(
      "Extracted audio file was empty.",
      422,
    );
  }

  if (stats.size > maxOutputBytes) {
    throw new MediaProcessingError(
      "Extracted audio exceeds Canva's 250 MB upload limit.",
      413,
    );
  }

  const audioProbe = await probeMedia(outputPath, timeoutMs);
  const durationSec = Number.parseFloat(
    audioProbe.format?.duration ??
      audioProbe.streams?.[0]?.duration ??
      "0",
  );
  const durationMs =
    Number.isFinite(durationSec) && durationSec > 0
      ? Math.round(durationSec * 1000)
      : 1000;

  return {
    durationMs,
    sizeBytes: stats.size,
  };
}

export async function downloadRemoteVideo(params: {
  rawUrl: string;
  destPath: string;
  maxBytes: number;
  timeoutMs: number;
}): Promise<void> {
  const { rawUrl, destPath, maxBytes, timeoutMs } = params;
  const validatedUrl = await validateRemoteVideoUrl(rawUrl);

  let response: Response;
  try {
    response = await fetch(validatedUrl.toString(), {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new ValidationError(
        "Timed out while downloading the selected Canva video.",
        504,
      );
    }
    throw new ValidationError(
      "Failed to download the selected Canva video.",
      502,
    );
  }

  if (!response.ok || !response.body) {
    throw new ValidationError(
      `Unable to download video from Canva (status ${response.status}).`,
      502,
    );
  }

  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new ValidationError(
        "The selected video exceeds the maximum allowed file size.",
        413,
      );
    }
  }

  let receivedBytes = 0;
  const reader = response.body.getReader();
  const writeStream = fs.createWriteStream(destPath);

  const nodeReadable = new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) {
          this.push(null);
          return;
        }
        receivedBytes += value.byteLength;
        if (receivedBytes > maxBytes) {
          await reader.cancel();
          this.destroy(
            new ValidationError(
              "The selected video exceeds the maximum allowed file size.",
              413,
            ),
          );
          return;
        }
        this.push(Buffer.from(value));
      } catch (err) {
        this.destroy(err instanceof Error ? err : new Error("Stream error"));
      }
    },
  });

  await pipeline(nodeReadable, writeStream);
}
