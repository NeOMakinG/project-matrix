import { parseArgs } from "node:util";
import { type DoctorAdapters, localAdapters, OUTPUT_CAP } from "./doctor-adapters";

export const DOCTOR_USAGE = `matrix doctor [--json] [--optional] [--trusted-tools-dir <absolute-directory>]
  Read-only prerequisite checks; no hooks, inference, installs or config changes.
  Ignores inherited PATH. Defaults: nonsymlink /usr/bin and /bin (none on Windows).
  --trusted-tools-dir explicitly approves an operator install directory; repeatable.
  Directories/binaries must be canonical, nonsymlink, not project-local or group/world-writable.
  Only the running Bun executable is implicitly trusted, never its sibling tools.
  --optional also checks Orca and Tailscale. Exit 2 means blocked; warnings are not readiness.
  Postgres: MATRIX_DOCTOR_POSTGRES_URL or DATABASE_URL (protocol reachability only).
  Gateway: MATRIX_DOCTOR_GATEWAY_URL (loopback /v1/models); optional
  MATRIX_DOCTOR_GATEWAY_HEALTH_URL and MATRIX_DOCTOR_GATEWAY_TOKEN in protected environment.
  Per-check timeout 3s, total deadline 20s, output cap 16KiB. No paid API fallback.`;

export interface DoctorCheck {
  id: string;
  status: "pass" | "warn" | "fail" | "unsupported";
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  blocked: boolean;
  publishBlocked: boolean;
  runtimeVerified: false;
}

async function bounded<Value>(
  fn: (signal: AbortSignal) => Promise<Value>,
  timeout: number,
): Promise<Value> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            controller.abort();
            reject(new Error("deadline"));
          },
          Math.max(1, timeout),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function loopbackUrl(value: string): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("local URL required");
  return url;
}

export async function diagnose(adapters: DoctorAdapters, optional = false): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const deadline = Date.now() + 20_000;
  const add = (id: string, status: DoctorCheck["status"], detail: string) => {
    checks.push({ id, status, detail });
  };
  const check = async (
    id: string,
    fn: (signal: AbortSignal) => Promise<string>,
    failure: string,
    required = true,
  ) => {
    try {
      if (Date.now() >= deadline) throw new Error("deadline");
      add(id, "pass", await bounded(fn, Math.min(3_000, deadline - Date.now())));
    } catch {
      add(id, required ? "fail" : "warn", failure);
    }
  };
  const command = async (name: string, args: string[], signal: AbortSignal) => {
    const output = await adapters.command(name, args, signal);
    if (Buffer.byteLength(output) > OUTPUT_CAP) throw new Error("output limit");
    return output;
  };
  const get = async (url: URL, signal: AbortSignal) => {
    const output = await adapters.get(url, adapters.env.MATRIX_DOCTOR_GATEWAY_TOKEN, signal);
    if (Buffer.byteLength(output) > OUTPUT_CAP) throw new Error("output limit");
    return output;
  };
  await check(
    "bun",
    async (signal) => {
      if (!/^\d+\.\d+\.\d+/m.test(await command("bun", ["--version"], signal)))
        throw new Error("version");
      return "Bun available; project compatibility still requires tests.";
    },
    "Bun probe failed or timed out. Run with trusted Bun or explicitly approve its canonical install directory using --trusted-tools-dir.",
  );
  await check(
    "git",
    async (signal) => {
      const version = /git version (\d+)\.(\d+)/.exec(await command("git", ["--version"], signal));
      if (
        !version ||
        Number(version[1]) < 2 ||
        (Number(version[1]) === 2 && Number(version[2]) < 40)
      )
        throw new Error("version");
      return "Git >=2.40 available.";
    },
    "Install or upgrade Git to >=2.40 (Windows: use the Linux toolchain inside WSL2).",
  );

  if (adapters.platform !== "linux") {
    add(
      "sandbox",
      "unsupported",
      adapters.platform === "darwin"
        ? "macOS Podman VM/path bridging is not validated. Run orchestration on a reviewed Linux host."
        : "Native Windows/other OS sandbox runtime unsupported. Run doctor inside WSL2/Linux; VM isolation still needs QA.",
    );
  } else {
    if (/microsoft|wsl/i.test(adapters.release))
      add(
        "wsl",
        "warn",
        "WSL detected: kernel namespaces/cgroups and filesystem mounts require runtime QA.",
      );
    await check(
      "sandbox",
      async (signal) => {
        try {
          const info = JSON.parse(await command("podman", ["info", "--format=json"], signal));
          if (info.host?.security?.rootless === true)
            return "Rootless Podman detected; image, broker, cgroups and container execution NOT verified.";
        } catch {}
        await command(
          "bwrap",
          ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "--", "/usr/bin/true"],
          signal,
        );
        return "bwrap namespace probe passed; Matrix runner, limits and broker NOT verified.";
      },
      "No usable rootless Podman/bwrap. Ask host administrator to install Podman with subuid/subgid, or enable bwrap user namespaces; do not use sudo Matrix.",
    );
  }
  add(
    "runtime",
    "warn",
    "Runtime integration unverified: no image pulls, containers, project commands or model inference executed.",
  );
  await check(
    "gitleaks",
    async (signal) => {
      if (!/\d+\.\d+/.test(await command("gitleaks", ["version"], signal)))
        throw new Error("version");
      return "gitleaks available; this is NOT a secret scan or publish approval.";
    },
    "Publishing blocked: install gitleaks in a system/explicitly approved nonsymlink tools directory and run the reviewed publish scan.",
  );

  const postgres = adapters.env.MATRIX_DOCTOR_POSTGRES_URL ?? adapters.env.DATABASE_URL;
  if (!postgres)
    add(
      "postgres",
      "fail",
      "Configure a protected MATRIX_DOCTOR_POSTGRES_URL (or DATABASE_URL). Cached server uses MemoryCore, not this database.",
    );
  else
    await check(
      "postgres",
      async (signal) => {
        const url = new URL(postgres);
        if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname)
          throw new Error("URL");
        const port = Number(url.port || 5432);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port");
        await adapters.postgres(url.hostname.replace(/^\[|\]$/g, ""), port, signal);
        return "PostgreSQL SSLRequest response received; authentication, TLS and migrations NOT verified. No credentials sent.";
      },
      "Configured PostgreSQL unreachable/invalid or timed out. Check host listener/firewall; authentication is not tested.",
    );

  const gateway = adapters.env.MATRIX_DOCTOR_GATEWAY_URL;
  if (!gateway)
    add(
      "gateway-models",
      "fail",
      "Configure MATRIX_DOCTOR_GATEWAY_URL to an operator-owned loopback gateway (use a reviewed tunnel for a remote local gateway).",
    );
  else
    await check(
      "gateway-models",
      async (signal) => {
        const url = loopbackUrl(gateway);
        if (url.pathname !== "/") throw new Error("base URL required");
        url.pathname = "/v1/models";
        const body = JSON.parse(await get(url, signal));
        if (
          !Array.isArray(body.data) ||
          !body.data.length ||
          !body.data.every(
            (model: unknown) =>
              typeof model === "object" &&
              model !== null &&
              "id" in model &&
              typeof model.id === "string" &&
              model.id.length > 0,
          )
        )
          throw new Error("models");
        return "Local gateway returned a nonempty model list; identities/auth omitted. No inference or paid fallback.";
      },
      "Local gateway models unavailable/invalid. Use a loopback HTTP(S) origin, check gateway auth and /v1/models; redirects refused.",
    );
  const health = adapters.env.MATRIX_DOCTOR_GATEWAY_HEALTH_URL;
  if (!health)
    add(
      "gateway-health",
      "warn",
      "Set MATRIX_DOCTOR_GATEWAY_HEALTH_URL to the gateway's documented read-only health endpoint; no health route assumed.",
    );
  else
    await check(
      "gateway-health",
      async (signal) => {
        const url = loopbackUrl(health);
        if (
          !gateway ||
          url.origin !== loopbackUrl(gateway).origin ||
          /\/(chat|completions|responses|messages|generate)(\/|$)/i.test(url.pathname)
        )
          throw new Error("health URL");
        await get(url, signal);
        return "Configured health endpoint returned HTTP success; readiness semantics are gateway-specific.";
      },
      "Gateway health failed/invalid. Use a documented read-only path on the same loopback gateway origin.",
    );
  await check(
    "headroom",
    async () => {
      const { ram, disk } = await adapters.resources();
      if (
        !Number.isFinite(ram) ||
        !Number.isFinite(disk) ||
        ram < 4 * 1024 ** 3 ||
        disk < 10 * 1024 ** 3
      )
        throw new Error("headroom");
      return "At least 4GiB free RAM and 10GiB disk at cwd; host estimate, not VM/cgroup reservation.";
    },
    "Headroom insufficient/unavailable: target >=4GiB free RAM and >=10GiB disk; check VM/cgroup limits separately.",
    false,
  );
  if (optional) {
    for (const name of ["orca", "tailscale"])
      await check(
        name,
        async (signal) => {
          await command(name, [name === "orca" ? "--version" : "version"], signal);
          return `${name} installed; service, authentication and pairing NOT verified.`;
        },
        `${name} unavailable; install only if required. Optional integration remains unverified.`,
        false,
      );
  }
  return {
    checks,
    blocked: checks.some((entry) => entry.status === "fail" || entry.status === "unsupported"),
    publishBlocked: checks.find((entry) => entry.id === "gitleaks")?.status !== "pass",
    runtimeVerified: false,
  };
}

export async function doctorCommand(
  argv: string[],
  adapters: DoctorAdapters | undefined = undefined,
  write: (text: string) => void = console.log,
): Promise<number> {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        json: { type: "boolean" },
        optional: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        "trusted-tools-dir": { type: "string", multiple: true },
      },
    });
    if (values.help) {
      write(DOCTOR_USAGE);
      return 0;
    }
    const report = await diagnose(
      adapters ?? localAdapters(values["trusted-tools-dir"]),
      values.optional,
    );
    write(
      values.json
        ? JSON.stringify(report, null, 2)
        : report.checks
            .map((entry) => `${entry.status.toUpperCase()} ${entry.id}: ${entry.detail}`)
            .join("\n"),
    );
    return report.blocked ? 2 : 0;
  } catch {
    const error =
      "matrix doctor: invalid options or diagnostic failure (details withheld). Use --help.";
    write(
      argv.includes("--json")
        ? JSON.stringify({ error, blocked: true, publishBlocked: true, runtimeVerified: false })
        : error,
    );
    return 2;
  }
}
