# Orca runtime on bosgame

> **Stale (2026-10-22):** the live runtime is the Orca Electron app in serve mode (port 6768,
> started by the Orca CLI), not this unit on port 7420. See [docs/orca.md](../../docs/orca.md)
> for the current runtime, firewalling and `MATRIX_RUNTIME=orca`.

Matrix's preferred workspace layer (ADR 0006) runs ticket worktrees on a headless Orca runtime on bosgame. You watch or take over runs from Orca on your Mac. Nothing here runs automatically; these are steps you take once.

## 1. Configure

```sh
mkdir -p ~/.config/matrix ~/matrix/projects
cat > ~/.config/matrix/orca-serve.env <<'ENV'
ORCA_PORT=7420
ORCA_PAIRING_ADDRESS=bosgame.<your-tailnet>.ts.net
ENV
```

**Required firewall (do this before starting the service).** `orca serve` has no bind-address flag, so it listens on all interfaces. Allow its port on the Tailscale interface only:

```sh
sudo ufw allow in on tailscale0 to any port 7420 proto tcp
sudo ufw deny 7420/tcp
sudo ufw status | grep 7420
```

The unit also sets `IPAddressDeny=any` / `IPAddressAllow=localhost 100.64.0.0/10 fd7a:115c:a1e0::/48` as defence in depth (enforced only where the systemd user manager supports IP filtering). Check what's listening with `ss -ltnp | grep 7420`.

`--pairing-address` is the host clients use to reach the runtime. Use the Tailscale name, so pairing and traffic stay on the tailnet. Make sure the port isn't open on public interfaces, for example with a host firewall rule allowing `7420/tcp` on `tailscale0` only.

## 2. Install and start the user service

```sh
cp ops/bosgame/orca-serve.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now orca-serve
journalctl --user -u orca-serve -f   # shows the pairing code on first start
```

Lingering is already enabled for `neo`, so the service keeps running after you log out.

## 3. Pair from your Mac

Use the pairing code printed by the service:

```sh
orca environment add --name bosgame --pairing-code <code>
orca environment list
```

Matrix's Orca workspace adapter then targets it with `environment: "bosgame"`.

## 4. Matrix hooks and MCP for Orca agents

```sh
matrix orca hooks install --server http://bosgame.<tailnet>.ts.net:<matrix-port>                 # dry run
MATRIX_ORCA_HOOK_SECRET=<secret> matrix orca hooks install --apply --server <url>                # writes ~/.matrix/orca only
matrix orca register-mcp --server <url> --project <id>                                         # dry run
MATRIX_ADMIN_KEY=<admin key> matrix orca register-mcp --server <url> --project <id> --apply      # https, or add --allow-tailnet-http for http over Tailscale
```

The hook secret must match the server's Orca webhook secret. The hooks command prints the agent config changes (Claude Code `hooks`, Codex `notify`, OpenCode plugin) for you to add yourself; Matrix never edits Orca's or the agents' hook configs.

## Remove

```sh
systemctl --user disable --now orca-serve
orca environment rm --environment bosgame
matrix orca hooks uninstall --apply
```
