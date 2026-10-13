import { canonicalFigmaFile, contentHash, type PhaseContext, screenshotHash } from "@matrix/core";
import { createFigmaDesignAdapter } from "./factory.js";

export async function captureAuthorizedFrames(
  options: Parameters<typeof createFigmaDesignAdapter>[0],
  ctx: PhaseContext,
  frameUrls: string[],
) {
  if (!frameUrls.length || frameUrls.length > 20) throw new Error("select 1-20 authorized frames");
  const runtime = await createFigmaDesignAdapter(options);
  try {
    await runtime.figma.assertAvailable(ctx, runtime.capability);
    const captures = [];
    for (const frameUrl of frameUrls) {
      const capture = await runtime.figma.capture(ctx, frameUrl);
      captures.push({
        source: "matrix:operator-live-capture:v1",
        projectId: ctx.project.id,
        ticketId: ctx.ticket.id,
        runId: ctx.runId,
        headSha: ctx.headSha,
        fileIdentity: canonicalFigmaFile(frameUrl),
        configurationSha256: runtime.capability.configurationSha256,
        frameUrl: capture.frameUrl,
        contentSha256: contentHash(capture.content),
        screenshot: {
          path: capture.screenshot.path,
          sha256: screenshotHash(capture.screenshot.bytes),
        },
      });
    }
    return { capability: runtime.capability, captures, approved: false as const };
  } finally {
    await runtime.close();
  }
}
