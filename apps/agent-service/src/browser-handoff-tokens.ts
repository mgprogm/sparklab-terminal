import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

export interface HandoffOwner {
  user: string;
  chatId: string;
  browserId: string;
}

interface TokenRecord extends HandoffOwner {
  handoffId: string;
  digest: Buffer;
  expiresAt: number;
  used: boolean;
}

export class HandoffTokenManager {
  private records = new Map<string, TokenRecord>();

  issue(
    owner: HandoffOwner,
    ttlMs: number,
    now = Date.now(),
  ): {
    handoffId: string;
    token: string;
    expiresAt: number;
  } {
    const handoffId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    this.records.set(handoffId, {
      ...owner,
      handoffId,
      digest: digest(token),
      expiresAt: now + ttlMs,
      used: false,
    });
    return { handoffId, token, expiresAt: now + ttlMs };
  }

  consume(
    handoffId: string,
    token: string,
    owner: HandoffOwner,
    now = Date.now(),
  ): boolean {
    const record = this.records.get(handoffId);
    if (
      !record ||
      record.used ||
      record.expiresAt <= now ||
      record.user !== owner.user ||
      record.chatId !== owner.chatId ||
      record.browserId !== owner.browserId
    )
      return false;
    const candidate = digest(token);
    if (
      candidate.length !== record.digest.length ||
      !timingSafeEqual(candidate, record.digest)
    )
      return false;
    record.used = true;
    return true;
  }

  revoke(handoffId: string): void {
    this.records.delete(handoffId);
  }
}

function digest(token: string): Buffer {
  // Avoid retaining the bearer token in manager records.
  return createHash("sha256").update(token, "ascii").digest();
}
