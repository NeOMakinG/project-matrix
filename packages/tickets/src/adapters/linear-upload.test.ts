import { expect, test } from "vitest";
import { fakeLinear } from "../testing/linear-fake";
import { LinearClient, type UploadFetch } from "./linear-client";

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
