# bosgame container setup

Rootless Podman for agent runs (ADR 0002). One-time, needs sudo:

```bash
cd ~/orca/projects/project-matrix && scp -r ops/bosgame bosgame:/tmp/matrix-ops && ssh -t bosgame 'sudo bash /tmp/matrix-ops/setup-podman.sh && bash /tmp/matrix-ops/check-podman.sh'
```

What it does:

- Installs `podman`, `crun`, `uidmap` and `passt`.
- Ensures subordinate uid/gid ranges for `neo` (already present: 100000:65536).
- Reloads Ubuntu's own AppArmor profiles that allow user namespaces only for `/usr/bin/podman` and `/usr/bin/crun`. The global `kernel.apparmor_restrict_unprivileged_userns=1` stays on, so other programs still can't create user namespaces.
- Enables lingering for `neo` and migrates rootless storage.

`check-podman.sh` (no sudo) confirms rootless mode, runs a container, and checks that containers can't reach the host browser debugging port `127.0.0.1:9223` or see `/home/neo/.hermes`.

Trade-off: the profiles are `unconfined` apart from the userns permission, so they widen nothing beyond what Podman itself needs. Disabling the sysctl globally would also work but would let any program create user namespaces.
