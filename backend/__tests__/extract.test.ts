/**
 * @jest-environment node
 */
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import ffmpegPath from "ffmpeg-static";
import { createAudioExtractorRouter } from "../app";
import type { BackendConfig } from "../config";
import { probeMedia } from "../media";
import { TempAudioStore } from "../store";

const execFileAsync = promisify(execFile);

describe("Audio Extractor Backend Integration", () => {
  let tmpRoot: string;
  let videoWithAudioPath: string;
  let videoWithoutAudioPath: string;
  let corruptedVideoPath: string;
  let server: http.Server;
  let baseUrl: string;
  let store: TempAudioStore;

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "canva-ae-test-"));
    videoWithAudioPath = path.join(tmpRoot, "with-audio.mp4");
    videoWithoutAudioPath = path.join(tmpRoot, "without-audio.mp4");
    corruptedVideoPath = path.join(tmpRoot, "corrupted.mp4");

    if (!ffmpegPath) {
      throw new Error("ffmpeg-static binary missing");
    }

    // Generate synthetic 1.5s video with audio
    await execFileAsync(ffmpegPath, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=160x120:d=1.5",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1.5",
      "-c:v",
      "mpeg4",
      "-c:a",
      "aac",
      "-shortest",
      videoWithAudioPath,
    ]);

    // Generate synthetic 1.5s video without audio
    await execFileAsync(ffmpegPath, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=160x120:d=1.5",
      "-c:v",
      "mpeg4",
      "-an",
      videoWithoutAudioPath,
    ]);

    // Generate corrupted file
    await fsp.writeFile(corruptedVideoPath, "not a real video file", "utf8");

    const config: BackendConfig = {
      canvaAppId: "test-app-id",
      port: 0,
      maxFileSizeBytes: 50 * 1024 * 1024,
      extractionTimeoutMs: 30_000,
      fetchTimeoutMs: 15_000,
      audioTtlMs: 60_000,
      tempDir: path.join(tmpRoot, "store"),
    };

    store = new TempAudioStore(config.tempDir, config.audioTtlMs);
    await store.init();

    const testAuthMiddleware = (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => {
      const authHeader = req.header("authorization");
      if (authHeader !== "Bearer valid-test-token") {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      req.canva = {
        user: {
          appId: "test-app-id",
          userId: "user-123",
          brandId: "brand-456",
        },
      } as Request["canva"];
      next();
    };

    const app = express();
    app.use(express.json());
    app.use(
      createAudioExtractorRouter({
        config,
        store,
        authMiddleware: testAuthMiddleware,
      }),
    );

    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind test server");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    await store?.shutdown();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (tmpRoot) {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  async function postVideoFile(filePath: string, token = "valid-test-token") {
    const buffer = await fsp.readFile(filePath);
    const formData = new FormData();
    formData.append(
      "video",
      new Blob([buffer], { type: "video/mp4" }),
      path.basename(filePath),
    );
    formData.append("title", path.basename(filePath));

    return fetch(`${baseUrl}/api/extract`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
  }

  it("rejects unauthorized requests without a valid Canva user token", async () => {
    const res = await fetch(`${baseUrl}/api/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoUrl: "https://example.com/video.mp4" }),
    });
    expect(res.status).toBe(401);
  });

  it("extracts MP3 audio from a valid video, serves it, and cleans up", async () => {
    const res = await postVideoFile(videoWithAudioPath);
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      token: string;
      audioUrl: string;
      mimeType: string;
      durationMs: number;
      title: string;
    };

    expect(data.token).toBeTruthy();
    expect(data.mimeType).toBe("audio/mpeg");
    expect(data.title).toBe("with-audio");
    expect(data.durationMs).toBeGreaterThan(1000);
    expect(data.durationMs).toBeLessThan(2500);
    expect(data.audioUrl).toBe(`${baseUrl}/api/audio/${data.token}`);

    // Fetch the hosted MP3 and verify headers + valid MP3 stream via ffprobe
    const audioRes = await fetch(data.audioUrl);
    expect(audioRes.status).toBe(200);
    expect(audioRes.headers.get("content-type")).toBe("audio/mpeg");
    const mp3Buffer = Buffer.from(await audioRes.arrayBuffer());
    expect(mp3Buffer.length).toBeGreaterThan(1000);

    const verifyMp3Path = path.join(tmpRoot, "downloaded.mp3");
    await fsp.writeFile(verifyMp3Path, mp3Buffer);
    const probe = await probeMedia(verifyMp3Path, 10_000);
    expect(probe.streams?.[0]?.codec_type).toBe("audio");

    // Clean up via DELETE endpoint
    const deleteRes = await fetch(`${baseUrl}/api/audio/${data.token}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer valid-test-token" },
    });
    expect(deleteRes.status).toBe(204);

    // Subsequent GET should return 404
    const afterDeleteRes = await fetch(data.audioUrl);
    expect(afterDeleteRes.status).toBe(404);
  });

  it("returns 422 when the video contains no audio stream", async () => {
    const res = await postVideoFile(videoWithoutAudioPath);
    expect(res.status).toBe(422);
    const data = (await res.json()) as { error: string };
    expect(data.error).toMatch(/does not contain an audio track/i);
  });

  it("returns 400 when the uploaded file is corrupted or not a video", async () => {
    const res = await postVideoFile(corruptedVideoPath);
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toMatch(/not a valid or supported video/i);
  });

  it.each([
    ["http://example.com/video.mp4", /HTTPS/i],
    ["https://localhost/video.mp4", /not allowed/i],
    ["https://127.0.0.1/video.mp4", /IP address/i],
    ["https://169.254.169.254/latest/meta-data", /IP address/i],
  ])("blocks SSRF attempt for %s", async (videoUrl, expectedError) => {
    const res = await fetch(`${baseUrl}/api/extract`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer valid-test-token",
      },
      body: JSON.stringify({ videoUrl }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toMatch(expectedError);
  });
});
