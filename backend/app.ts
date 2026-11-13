import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { user } from "@canva/app-middleware/express";
import cors from "cors";
import express from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import multer from "multer";
import type { BackendConfig } from "./config";
import {
  MediaProcessingError,
  downloadRemoteVideo,
  extractAudioToMp3,
  validateVideoHasAudio,
} from "./media";
import { ValidationError, sanitizeAudioTitle } from "./security";
import type { TempAudioStore } from "./store";
import { safeUnlink } from "./store";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AudioExtractorRouterOptions {
  config: BackendConfig;
  store: TempAudioStore;
  authMiddleware?: RequestHandler;
}

function buildAllowedOrigins(config: BackendConfig): Set<string> {
  const origins = new Set<string>([
    `https://app-${config.canvaAppId.toLowerCase()}.canva-apps.com`,
    "http://localhost:8080",
    "https://localhost:8080",
  ]);
  if (config.canvaAppOrigin) {
    origins.add(config.canvaAppOrigin);
  }
  return origins;
}

function resolvePublicBaseUrl(req: Request, config: BackendConfig): string {
  if (config.publicBackendUrl) {
    return config.publicBackendUrl.replace(/\/+$/, "");
  }
  const forwardedProto = req.header("x-forwarded-proto");
  const protocol = forwardedProto?.split(",")[0]?.trim() || req.protocol;
  const host = req.header("x-forwarded-host") || req.get("host");
  return `${protocol}://${host}`;
}

export function createAudioExtractorRouter(
  options: AudioExtractorRouterOptions,
): express.Router {
  const { config, store } = options;
  const router = express.Router();
  const allowedOrigins = buildAllowedOrigins(config);

  router.use(
    cors({
      origin(origin, callback) {
        // Allow server-to-server requests (e.g. Canva backend fetching audio) and allowed app origins
        if (!origin || allowedOrigins.has(origin)) {
          callback(null, true);
          return;
        }
        callback(new ValidationError("Origin not allowed by CORS.", 403));
      },
      optionsSuccessStatus: 200,
    }),
  );

  // Publicly accessible endpoint for Canva's backend to download the temporary MP3.
  // Protected by a cryptographically random UUID token and short TTL.
  router.get("/api/audio/:token", (req, res) => {
    const { token } = req.params;
    if (!token || !UUID_REGEX.test(token)) {
      res.status(404).json({ error: "Audio not found." });
      return;
    }

    const entry = store.get(token);
    if (!entry) {
      res.status(404).json({ error: "Audio not found or expired." });
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", String(entry.sizeBytes));
    res.setHeader("Cache-Control", "no-store");

    const stream = fs.createReadStream(entry.filePath);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.status(404).json({ error: "Audio file unavailable." });
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  });

  // All extraction and cleanup endpoints require a verified Canva user JWT
  const authMiddleware =
    options.authMiddleware ?? user.verifyToken({ appId: config.canvaAppId });
  router.use("/api", authMiddleware);

  const uploadMiddleware = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        cb(null, config.tempDir);
      },
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || "").slice(0, 10) || ".mp4";
        cb(null, `${crypto.randomUUID()}${ext}`);
      },
    }),
    limits: {
      fileSize: config.maxFileSizeBytes,
      files: 1,
    },
  });

  const handleUpload: RequestHandler = (req, res, next) => {
    const contentType = req.header("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      next();
      return;
    }
    uploadMiddleware.single("video")(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          next(
            new ValidationError(
              "The selected video exceeds the 250 MB size limit.",
              413,
            ),
          );
          return;
        }
        next(new ValidationError(err.message, 400));
        return;
      }
      if (err) {
        next(err);
        return;
      }
      next();
    });
  };

  router.post(
    "/api/extract",
    handleUpload,
    async (req: Request, res: Response, next: NextFunction) => {
      const userId = req.canva?.user?.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized Canva user." });
        return;
      }

      let inputVideoPath: string | undefined;
      let outputAudioPath: string | undefined;
      let audioRegistered = false;

      try {
        const body = (req.body ?? {}) as {
          videoUrl?: unknown;
          title?: unknown;
        };

        let title: string;
        if (req.file) {
          inputVideoPath = req.file.path;
          if (req.file.size === 0) {
            throw new ValidationError("The selected video file is empty.", 400);
          }
          title = sanitizeAudioTitle(body.title ?? req.file.originalname);
        } else if (body.videoUrl !== undefined) {
          inputVideoPath = store.createTempFilePath(".mp4");
          await downloadRemoteVideo({
            rawUrl: String(body.videoUrl),
            destPath: inputVideoPath,
            maxBytes: config.maxFileSizeBytes,
            timeoutMs: config.fetchTimeoutMs,
          });
          title = sanitizeAudioTitle(body.title);
        } else {
          throw new ValidationError(
            "Provide either a video file or a Canva video URL.",
            400,
          );
        }

        await validateVideoHasAudio(inputVideoPath, config.extractionTimeoutMs);

        outputAudioPath = store.createTempFilePath(".mp3");
        const { durationMs, sizeBytes } = await extractAudioToMp3({
          inputPath: inputVideoPath,
          outputPath: outputAudioPath,
          timeoutMs: config.extractionTimeoutMs,
          maxOutputBytes: config.maxFileSizeBytes,
        });

        const entry = store.register({
          filePath: outputAudioPath,
          sizeBytes,
          ownerUserId: userId,
        });
        audioRegistered = true;

        const baseUrl = resolvePublicBaseUrl(req, config);
        const audioUrl = `${baseUrl}/api/audio/${entry.token}`;

        res.status(200).json({
          token: entry.token,
          audioUrl,
          mimeType: "audio/mpeg",
          durationMs,
          title,
        });
      } catch (err) {
        if (!audioRegistered) {
          await safeUnlink(outputAudioPath);
        }
        if (
          err instanceof ValidationError ||
          err instanceof MediaProcessingError
        ) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        next(err);
      } finally {
        await safeUnlink(inputVideoPath);
      }
    },
  );

  router.delete("/api/audio/:token", async (req, res) => {
    const userId = req.canva?.user?.userId;
    const { token } = req.params;
    if (!userId || !token || !UUID_REGEX.test(token)) {
      res.status(404).json({ error: "Audio not found." });
      return;
    }

    const removed = await store.remove(token, userId);
    if (!removed) {
      res.status(404).json({ error: "Audio not found." });
      return;
    }
    res.status(204).send();
  });

  // Surface validation errors cleanly
  router.use(
    (err: Error, _req: Request, res: Response, next: NextFunction) => {
      if (
        err instanceof ValidationError ||
        err instanceof MediaProcessingError
      ) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      next(err);
    },
  );

  return router;
}
