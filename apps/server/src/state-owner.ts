import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { preparePrivateFile } from "./private-state.js";

const GUARDIAN = `
import fcntl, json, os, signal, stat, sys
signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGINT, signal.SIG_IGN)
lock, ready, identity = sys.argv[1:]
descriptor = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
entry = os.fstat(descriptor)
status = "owned"
try:
    if not stat.S_ISREG(entry.st_mode) or entry.st_mode & 0o077 or entry.st_uid != os.geteuid():
        raise RuntimeError("unsafe lock")
    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.ftruncate(descriptor, 0)
    os.write(descriptor, identity.encode())
    os.fsync(descriptor)
except Exception:
    status = "unavailable"
response = os.open(ready + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
os.write(response, json.dumps({"status": status, "inode": entry.st_ino, "device": entry.st_dev}).encode())
os.fsync(response)
os.close(response)
os.rename(ready + ".tmp", ready)
if status != "owned":
    sys.exit(73)
sys.stdin.buffer.read()
os.close(descriptor)
`;

export class PrivateStateOwner {
  readonly directory: string;
  private readonly lock: string;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly inode: number;
  private readonly device: number;
  private readonly identity = randomUUID();
  private active = true;
  private readonly cancellation = new AbortController();
  readonly signal = this.cancellation.signal;
  private serverClaimed = false;
  private factoryClaimed = false;
  private readonly stores = new Set<string>();
  private closing?: Promise<void>;

  constructor(directory: string) {
    const lock = preparePrivateFile(join(directory, ".state-owner.lock")) as string;
    this.directory = realpathSync(dirname(lock));
    this.lock = join(this.directory, ".state-owner.lock");
    const ready = join(this.directory, `.state-owner-${randomUUID()}.ready`);
    this.child = spawn("python3", ["-I", "-c", GUARDIAN, this.lock, ready, this.identity], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdio: "pipe",
    });
    this.child.on("error", () => this.loseOwnership());
    this.child.on("exit", () => this.loseOwnership());
    let status: { status: string; inode: number; device: number } | undefined;
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          status = JSON.parse(readFileSync(ready, "utf8"));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (!this.child.pid) break;
        spawnSync("sleep", ["0.01"], { stdio: "ignore" });
      }
      if (status?.status !== "owned")
        throw new Error("private state lifetime ownership unavailable; refusing a second owner");
      this.inode = status.inode;
      this.device = status.device;
    } catch (error) {
      this.active = false;
      this.child.stdin.destroy();
      this.child.kill();
      throw error;
    } finally {
      try {
        unlinkSync(ready);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  assertOwned(): void {
    if (!this.active || !this.child.pid) throw new Error("private state lifetime ownership lost");
    try {
      process.kill(this.child.pid, 0);
      const descriptor = openSync(this.lock, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const entry = fstatSync(descriptor);
        if (
          !entry.isFile() ||
          entry.ino !== this.inode ||
          entry.dev !== this.device ||
          entry.mode & 0o077 ||
          readFileSync(descriptor, "utf8") !== this.identity
        )
          throw new Error("private state lock replaced");
      } finally {
        closeSync(descriptor);
      }
    } catch {
      this.loseOwnership();
      throw new Error("private state lifetime ownership lost");
    }
  }

  private loseOwnership(): void {
    this.active = false;
    if (!this.signal.aborted)
      this.cancellation.abort(new Error("private state lifetime ownership lost"));
  }

  async guard<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOwned();
    let abort!: () => void;
    const lost = new Promise<never>((_resolve, reject) => {
      abort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const result = await Promise.race([operation(), lost]);
      this.assertOwned();
      return result;
    } finally {
      this.signal.removeEventListener("abort", abort);
    }
  }

  fence<T extends object>(port: T): T {
    const methods = new Map<PropertyKey, { original: unknown; fenced: unknown }>();
    return new Proxy(port, {
      get: (target, key) => {
        const original: unknown = Reflect.get(target, key);
        if (typeof original !== "function") return original;
        const cached = methods.get(key);
        if (cached?.original === original) return cached.fenced;
        const fenced = (...args: unknown[]) =>
          this.guard(async () => Reflect.apply(original, target, args));
        methods.set(key, { original, fenced });
        return fenced;
      },
    });
  }

  assertFile(path: string): void {
    this.assertOwned();
    const file = join(realpathSync(dirname(path)), basename(path));
    if (file !== this.directory && !file.startsWith(`${this.directory}${sep}`))
      throw new Error("private state path outside owned directory");
  }

  claimServer(directory: string): void {
    this.assertDirectory(directory);
    if (this.serverClaimed) throw new Error("private state already belongs to one server instance");
    this.serverClaimed = true;
  }

  assertDirectory(directory: string): void {
    this.assertOwned();
    if (realpathSync(directory) !== this.directory)
      throw new Error("private state directory differs from its owner");
  }

  releaseServer(): void {
    this.serverClaimed = false;
  }

  claimFactory(): void {
    this.assertOwned();
    if (this.factoryClaimed)
      throw new Error("private state already belongs to one factory instance");
    this.factoryClaimed = true;
  }

  claimStore(path: string): void {
    this.assertFile(path);
    const file = join(realpathSync(dirname(path)), basename(path));
    if (this.stores.has(file)) throw new Error("private state store already loaded by its owner");
    this.stores.add(file);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.loseOwnership();
    this.closing = new Promise((resolveClose) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolveClose();
        return;
      }
      this.child.once("close", () => resolveClose());
      this.child.stdin.end();
    });
    return this.closing;
  }
}
