import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

export interface StoredAudioEntry {
  token: string;
  filePath: string;
  sizeBytes: number;
  ownerUserId: string;
  expiresAt: number;
}

export class TempAudioStore {
  private readonly entries = new Map<string, StoredAudioEntry>();
  private readonly tempDir: string;
  private readonly ttlMs: number;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(tempDir: string, ttlMs: number) {
    this.tempDir = tempDir;
    this.ttlMs = ttlMs;
  }

  async init(): Promise<void> {
    await fsp.mkdir(this.tempDir, { recursive: true });
    this.sweepTimer = setInterval(() => {
      void this.sweepExpired();
    }, Math.min(this.ttlMs, 60_000));
    this.sweepTimer.unref();
  }

  createTempFilePath(extension: string): string {
    const safeExt = extension.startsWith(".") ? extension : `.${extension}`;
    return path.join(this.tempDir, `${crypto.randomUUID()}${safeExt}`);
  }

  register(params: {
    filePath: string;
    sizeBytes: number;
    ownerUserId: string;
  }): StoredAudioEntry {
    const token = crypto.randomUUID();
    const entry: StoredAudioEntry = {
      token,
      filePath: params.filePath,
      sizeBytes: params.sizeBytes,
      ownerUserId: params.ownerUserId,
      expiresAt: Date.now() + this.ttlMs,
    };
    this.entries.set(token, entry);
    return entry;
  }

  get(token: string): StoredAudioEntry | undefined {
    const entry = this.entries.get(token);
    if (!entry) {
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      void this.remove(token);
      return undefined;
    }
    return entry;
  }

  async remove(token: string, ownerUserId?: string): Promise<boolean> {
    const entry = this.entries.get(token);
    if (!entry) {
      return false;
    }
    if (ownerUserId && entry.ownerUserId !== ownerUserId) {
      return false;
    }
    this.entries.delete(token);
    await safeUnlink(entry.filePath);
    return true;
  }

  async sweepExpired(): Promise<void> {
    const now = Date.now();
    const expiredTokens: string[] = [];
    for (const [token, entry] of this.entries.entries()) {
      if (now > entry.expiresAt) {
        expiredTokens.push(token);
      }
    }
    await Promise.all(expiredTokens.map((token) => this.remove(token)));
  }

  async shutdown(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    const tokens = Array.from(this.entries.keys());
    await Promise.all(tokens.map((token) => this.remove(token)));
  }
}

export async function safeUnlink(filePath: string | undefined): Promise<void> {
  if (!filePath) {
    return;
  }
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // Ignore cleanup errors for already-removed temp files
    }
  }
}
