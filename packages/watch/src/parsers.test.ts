import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { stackKeywords } from "./cli.js";
import { githubRepo, parseTrending } from "./collectors/github.js";
import { bumpKind } from "./collectors/registries.js";
import { dedupe, normalizeUrl } from "./dedupe.js";
import { parseCargo, parseLock, parsePython, readDependencies } from "./deps.js";
import { isoWeek } from "./digest.js";
import { decodeEntities, parseFeed } from "./feed.js";

const RSS = `<?xml version="1.0"?>
<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>
<rss><channel>
<item><title>Bun 2.0 &amp; friends</title><link>https://bun.sh/blog/bun-v2?utm_source=x</link>
<description><![CDATA[<p>Faster <b>installs</b></p>]]></description><pubDate>Mon, 12 Oct 2026 08:00:00 GMT</pubDate></item>
<item><title>&lol2;</title><link>https://example.com/bomb</link></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom">
<entry><title type="html">Drizzle 1.0</title><link rel="alternate" href="https://orm.drizzle.team/blog/1"/>
<link rel="self" href="https://orm.drizzle.team/self"/><updated>2026-10-10T00:00:00Z</updated><summary>Stable &#x1F680;</summary></entry>
</feed>`;

describe("feeds", () => {
  test("parses RSS with CDATA and never expands DTD entities", () => {
    const entries = parseFeed(RSS);
    expect(entries[0]).toMatchObject({ title: "Bun 2.0 & friends", summary: "Faster installs" });
    expect(entries[0]?.publishedAt).toBe("2026-10-12T08:00:00.000Z");
    expect(entries[1]?.title).toBe("&lol2;");
  });
  test("parses Atom alternate links and numeric entities", () => {
    const [e] = parseFeed(ATOM);
    expect(e).toMatchObject({
      title: "Drizzle 1.0",
      url: "https://orm.drizzle.team/blog/1",
      summary: "Stable 🚀",
    });
  });
  test("decodeEntities ignores unknown named entities", () => {
    expect(decodeEntities("a &foo; &lt;b&gt; &#65;")).toBe("a &foo; <b> A");
  });
});

describe("deps", () => {
  test("reads npm workspaces with lockfile versions, Cargo and Python", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-deps-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"], devDependencies: { typescript: "^5.9.0" } }),
    );
    await mkdir(join(root, "packages", "a"), { recursive: true });
    await writeFile(
      join(root, "packages", "a", "package.json"),
      JSON.stringify({ dependencies: { zod: "^4", "@matrix/core": "workspace:*" } }),
    );
    await writeFile(
      join(root, "bun.lock"),
      `{"lockfileVersion":1,"packages":{"zod":["zod@4.1.5","",{}],"typescript":["typescript@5.9.2","",{},],},}`,
    );
    await writeFile(
      join(root, "Cargo.toml"),
      `[package]\nname="x"\n[dependencies]\nserde = { version = "1.0", features = ["derive"] }\ntokio = "1.40"\n`,
    );
    await writeFile(
      join(root, "requirements.txt"),
      "httpx>=0.27\n# comment\nrequests[socks]==2.32.3\n-e .\n",
    );
    const deps = await readDependencies(root);
    expect(deps.map((d) => `${d.ecosystem}:${d.name}:${d.resolved ?? d.version}`)).toEqual([
      "crates:serde:1.0",
      "crates:tokio:1.40",
      "npm:typescript:5.9.2",
      "npm:zod:4.1.5",
      "pypi:httpx:>=0.27",
      "pypi:requests:==2.32.3",
    ]);
  });
  test("individual parsers", () => {
    expect(parseLock(`{"packages":{"node_modules/react":{"version":"19.1.0"}}}`).get("react")).toBe(
      "19.1.0",
    );
    expect(parseCargo('[dev-dependencies]\nrstest = "0.18"')).toHaveLength(1);
    expect(
      parsePython(null, 'dependencies = ["fastapi>=0.115", "uvicorn"]').map((d) => d.name),
    ).toEqual(["fastapi", "uvicorn"]);
  });
});

describe("misc", () => {
  test("bumpKind", () => {
    expect(bumpKind("^5.9.0", "6.0.0")).toBe("major");
    expect(bumpKind("5.9.2", "5.10.0")).toBe("minor");
    expect(bumpKind("5.9.2", "5.9.2")).toBeNull();
    expect(bumpKind("5.9.2", "6.0.0-beta.1")).toBeNull();
  });
  test("githubRepo", () => {
    expect(githubRepo("git+https://github.com/colinhacks/zod.git")).toBe("colinhacks/zod");
    expect(githubRepo("https://gitlab.com/x/y")).toBeNull();
  });
  test("parseTrending", () => {
    const html = `<article class="Box-row"><h2 class="h3"><a href="/oven-sh/bun">oven-sh / bun</a></h2>
      <p class="col-9 color-fg-muted my-1 pr-4">Incredibly fast JavaScript runtime</p><span>1,234 stars this week</span></article>`;
    expect(parseTrending(html)).toEqual([
      {
        repo: "oven-sh/bun",
        description: "Incredibly fast JavaScript runtime",
        stars: "1,234 stars this week",
      },
    ]);
  });
  test("dedupe by normalised url and title", () => {
    const base = { source: "feed" as const, summary: "" };
    const items = dedupe([
      { ...base, id: "b", title: "Bun 2.0", url: "https://www.bun.sh/blog/v2/?utm_source=hn" },
      { ...base, id: "a", title: "Bun v2 released", url: "https://bun.sh/blog/v2" },
      { ...base, id: "c", title: "bun 2.0!", url: "https://other.example/x" },
    ]);
    expect(items.map((i) => i.id)).toEqual(["a"]);
    expect(normalizeUrl("https://www.x.com/a/?ref=1#h")).toBe("x.com/a");
  });
  test("isoWeek and stackKeywords", () => {
    expect(isoWeek(new Date("2026-10-12T10:00:00Z"))).toBe("2026-W42");
    expect(
      stackKeywords({
        frontend: { framework: "react", libs: ["tanstack-query", "zod"] },
        hosting: "fly",
        ok: true,
      }),
    ).toEqual(["react", "tanstack-query", "zod", "fly"]);
  });
});
