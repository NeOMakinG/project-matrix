# Orca runtime on bosgame

Matrix's preferred workspace layer (ADR 0006) runs ticket worktrees on a headless Orca runtime on bosgame. You watch or take over runs from Orca on your Mac. Nothing here runs automatically; these are steps you take once.

## 1. Configure

```sh
mkdir -p ~/.config/matrix ~/matrix/projects
cat > ~/.config/matrix/orca-serve.env <<'ENV'
ORCA_PORT=7420
ORCA_PAIRING_ADDRESS=bosgame.<your-tailnet>.ts.net
ENV
```

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
matrix orca register-mcp --server <url>                                                        # dry run
MATRIX_ADMIN_KEY=<admin key> matrix orca register-mcp --server <url> --apply                     # creates scoped keys, writes configs with .bak
```

The hook secret must match the server's Orca webhook secret. The hooks command prints the agent config changes (Claude Code `hooks`, Codex `notify`, OpenCode plugin) for you to add yourself; Matrix never edits Orca's or the agents' hook configs.

## Remove

```sh
systemctl --user disable --now orca-serve
orca environment rm --environment bosgame
matrix orca hooks uninstall --apply
```
