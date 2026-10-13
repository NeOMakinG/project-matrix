import { randomBytes, timingSafeEqual } from "node:crypto";
import { PrivateState } from "../private-state.js";
import type { PrivateStateOwner } from "../state-owner.js";
import type { Clock } from "./limits.js";

export interface Session {
  id: string;
  keyId: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
}

export const SESSION_COOKIE = "mx_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Server-side dashboard sessions: the cookie only carries a random id, never the API key. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  private readonly state: PrivateState<Session[]>;

  constructor(
    private readonly clock: Clock = Date.now,
    file?: string,
    owner?: PrivateStateOwner,
  ) {
    this.state = new PrivateState(file, owner);
    for (const session of this.state.load([])) {
      if (session.expiresAt > this.clock()) this.sessions.set(session.id, session);
    }
  }

  private persist(): void {
    this.state.save([...this.sessions.values()]);
  }

  create(keyId: string): Session {
    const now = this.clock();
    const session: Session = {
      id: randomBytes(32).toString("base64url"),
      keyId,
      csrfToken: randomBytes(32).toString("base64url"),
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    this.sessions.set(session.id, session);
    this.persist();
    return session;
  }

  get(id: string | undefined): Session | null {
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= this.clock()) {
      this.sessions.delete(id);
      this.persist();
      return null;
    }
    return session;
  }

  delete(id: string): void {
    this.sessions.delete(id);
    this.persist();
  }

  /** Ends every session of a key, e.g. when it's revoked. */
  deleteForKey(keyId: string): void {
    for (const [id, session] of this.sessions) {
      if (session.keyId === keyId) this.sessions.delete(id);
    }
    this.persist();
  }
}

export function csrfMatches(session: Session, presented: string | undefined): boolean {
  if (!presented) return false;
  const expected = Buffer.from(session.csrfToken);
  const actual = Buffer.from(presented);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
