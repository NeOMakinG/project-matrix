import { expect, test } from "vitest";
import { fakeLinear } from "../testing/linear-fake";
import {
  checkEvidenceUpload,
  isLinearAssetUrl,
  LinearClient,
  type UploadFetch,
} from "./linear-client";

const KEY = `lin_api_${"k".repeat(32)}`;

function uploadResponse(uploadUrl: string, assetUrl: string) {
  return {
    status: 200,
    body: JSON.stringify({
      data: {
        fileUpload: {
          success: true,
          uploadFile: { uploadUrl, assetUrl, headers: [{ key: "x-goog-meta", value: "1" }] },
        },
      },
    }),
  };
}

test("upload: signed PUT with Linear's headers, returns the asset URL", async () => {
  const fake = fakeLinear();
  fake.queue.push(
    uploadResponse("https://storage.example/put", "https://uploads.linear.app/a.png"),
  );
  const puts: Parameters<UploadFetch>[] = [];
  const client = new LinearClient({
    fetch: fake.fetch,
    env: { LINEAR_API_KEY: KEY },
    uploadFetch: async (...args) => {
      puts.push(args);
      return { ok: true, status: 200 };
    },
  });
  const bytes = new Uint8Array([137, 80, 78, 71]);
  expect(await client.upload("a.png", "image/png", bytes)).toBe("https://uploads.linear.app/a.png");
  expect(puts[0]?.[0]).toBe("https://storage.example/put");
  expect(puts[0]?.[1].headers).toMatchObject({ "Content-Type": "image/png", "x-goog-meta": "1" });
  expect(puts[0]?.[1].headers.Authorization).toBeUndefined();
  expect(puts[0]?.[1].body).toBe(bytes);
});

test("upload: non-https URLs and failed PUTs are errors", async () => {
  const fake = fakeLinear();
  fake.queue.push(uploadResponse("http://storage.example/put", "https://uploads.linear.app/a.png"));
  const ok: UploadFetch = async () => ({ ok: true, status: 200 });
  const client = new LinearClient({
    fetch: fake.fetch,
    env: { LINEAR_API_KEY: KEY },
    uploadFetch: ok,
  });
  await expect(client.upload("a.png", "image/png", new Uint8Array(1))).rejects.toThrow(/non-https/);
  fake.queue.push(
    uploadResponse("https://storage.example/put", "https://uploads.linear.app/a.png"),
  );
  const failing = new LinearClient({
    fetch: fake.fetch,
    env: { LINEAR_API_KEY: KEY },
    uploadFetch: async () => ({ ok: false, status: 403 }),
  });
  await expect(failing.upload("a.png", "image/png", new Uint8Array(1))).rejects.toThrow(/HTTP 403/);
});

test("upload: asset URLs outside Linear's upload host are refused before any PUT", async () => {
  for (const asset of [
    "https://evil.example/a.png",
    "https://uploads.linear.app.evil.example/a.png",
    "https://uploads.linear.app@evil.example/a.png",
    "https://uploads.linear.app:8443/a.png",
    "https://user@uploads.linear.app/a.png",
  ]) {
    const fake = fakeLinear();
    fake.queue.push(uploadResponse("https://storage.example/put", asset));
    let put = false;
    const client = new LinearClient({
      fetch: fake.fetch,
      env: { LINEAR_API_KEY: KEY },
      uploadFetch: async () => {
        put = true;
        return { ok: true, status: 200 };
      },
    });
    await expect(client.upload("a.png", "image/png", new Uint8Array(1))).rejects.toThrow(
      /outside Linear's upload host|non-https/,
    );
    expect(put).toBe(false);
  }
  expect(isLinearAssetUrl("https://uploads.linear.app/x/y/a.png")).toBe(true);
  expect(isLinearAssetUrl("not a url")).toBe(false);
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

test("evidence uploads: png/jpg/webp screenshots and txt/log text only", () => {
  expect(() => checkEvidenceUpload("s1.png", "image/png", PNG)).not.toThrow();
  expect(() => checkEvidenceUpload("s1.jpeg", "image/jpeg", JPG)).not.toThrow();
  expect(() => checkEvidenceUpload("s1.webp", "image/webp", WEBP)).not.toThrow();
  expect(() => checkEvidenceUpload("run.log", "text/plain", new Uint8Array([65]))).not.toThrow();
  for (const [name, type] of [
    ["page.html", "text/html"],
    ["x.svg", "image/svg+xml"],
    ["app.apk", "application/vnd.android.package-archive"],
    ["a.pdf", "application/pdf"],
  ] as const)
    expect(() => checkEvidenceUpload(name, type, PNG)).toThrow(/not allowed/);
});

test("evidence uploads: name, signature and size must match the type", () => {
  expect(() => checkEvidenceUpload("s1.html", "image/png", PNG)).toThrow(/does not match/);
  expect(() => checkEvidenceUpload("png", "image/png", PNG)).toThrow(/does not match/);
  expect(() => checkEvidenceUpload("s1.png", "image/png", JPG)).toThrow(/not image\/png/);
  expect(() => checkEvidenceUpload("s1.png", "image/png", new Uint8Array())).toThrow(/empty/);
  const big = new Uint8Array(10 * 1024 * 1024 + 1);
  big.set(PNG);
  expect(() => checkEvidenceUpload("s1.png", "image/png", big)).toThrow(/larger than 10 MB/);
  expect(() =>
    checkEvidenceUpload("run.log", "text/plain", new Uint8Array(1024 * 1024 + 1)),
  ).toThrow(/larger than 1 MB/);
});
