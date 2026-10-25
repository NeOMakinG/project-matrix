import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AdbMobileDriver, findNodeCenter } from "./mobile";
import { type CommandRunner, shellQuote, sshRunner } from "./mobile-runner";

const TREE = `<?xml version="1.0"?><hierarchy>${'<node text="" bounds="[0,0][1,1]" />'.repeat(10)}<node text="Choose photos" resource-id="com.app:id/pick" content-desc="" bounds="[100,200][300,400]" /></hierarchy>`;

function fake(handler: (argv: string[]) => { code?: number; out?: string | Buffer }) {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    run: async (argv) => {
      calls.push(argv);
      const r = handler(argv);
      const out = r.out ?? "";
      return {
        exitCode: r.code ?? 0,
        stdout: Buffer.isBuffer(out) ? out : Buffer.from(out),
        stderr: "",
      };
    },
  };
  return { calls, runner };
}

test("finds nodes by text, content-desc or resource id", () => {
  expect(findNodeCenter(TREE, { text: "Choose photos" })).toEqual({ x: 200, y: 300 });
  expect(findNodeCenter(TREE, { id: "com.app:id/pick" })).toEqual({ x: 200, y: 300 });
  expect(findNodeCenter(TREE, { text: "Nope" })).toBeUndefined();
});

test("tap by text retries stub dumps and quotes device shell words", async () => {
  let dumps = 0;
  const { calls, runner } = fake((argv) => {
    const cmd = argv.at(-1) ?? "";
    if (cmd.startsWith("'cat'")) return { out: ++dumps < 2 ? "<hierarchy/>" : TREE };
    return {};
  });
  const d = new AdbMobileDriver(runner, "emulator-5554");
  await d.tap({ text: "Choose photos" });
  expect(calls.at(-1)).toEqual([
    "adb",
    "-s",
    "emulator-5554",
    "shell",
    "'input' 'tap' '200' '300'",
  ]);
  await d.type("it's me; rm -rf /");
  expect(calls.at(-1)?.at(-1)).toBe(`'input' 'text' 'it'\\''s%sme;%srm%s-rf%s/'`);
});

test("screenshot requires PNG bytes and hashes them", async () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("x"),
  ]);
  const { runner } = fake(() => ({ out: png }));
  const path = join(mkdtempSync(join(tmpdir(), "adb-")), "s.png");
  const r = await new AdbMobileDriver(runner, "SM02E4072815934").screenshot(path);
  expect(r).toMatchObject({ kind: "screenshot", ok: true, path });
  expect(readFileSync(path).equals(png)).toBe(true);
  const bad = fake(() => ({ out: "error" }));
  await expect(new AdbMobileDriver(bad.runner, "x").screenshot(path)).rejects.toThrow(/PNG/);
});

test("rejects unsafe serials and app ids", async () => {
  expect(() => new AdbMobileDriver(fake(() => ({})).runner, "a b")).toThrow(/serial/);
  await expect(
    new AdbMobileDriver(fake(() => ({})).runner, "s").launch("x; reboot"),
  ).rejects.toThrow(/app id/);
});

test("ssh runner quotes every word for the remote shell", async () => {
  const { calls, runner } = fake(() => ({}));
  await sshRunner("root@100.90.255.43", runner).run(["adb", "shell", "a b; c"]);
  expect(calls[0]?.at(-1)).toBe("adb shell 'a b; c'");
  expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  expect(() => sshRunner("-oProxyCommand=x")).toThrow(/ssh host/);
});
