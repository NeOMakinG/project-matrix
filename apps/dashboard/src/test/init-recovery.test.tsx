import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { endpoints } from "@/api/endpoints";
import { queries } from "@/api/queries";
import type { InitProgress } from "@/api/view";
import { makeProgress } from "@/mocks/data/init";
import { mockDb } from "@/mocks/handlers";
import { reviseAnswer as serverReviseAnswer } from "../../../server/src/init-progress";
import { renderRoute } from "./render";
import { server } from "./server";

function interview() {
  let answers: Record<string, string> = { "backend.orm": "drizzle", "hosting.api": "fly" };
  const progress = (): InitProgress => ({
    ...makeProgress(answers),
    round: [],
    contradictions: [],
  });
  const session = () => ({
    id: "qa-init",
    projectId: "ledgerly",
    answers,
    state: "in_progress",
    createdAt: "2026-10-12T00:00:00Z",
  });
  server.use(
    http.get("http://matrix.test/v1/init/qa-init", () => HttpResponse.json(session())),
    http.get("http://matrix.test/v1/init/qa-init/progress", () => HttpResponse.json(progress())),
    http.get("http://matrix.test/v1/projects/ledgerly", () =>
      HttpResponse.json(mockDb().projects[0], { headers: { etag: '"project-v1"' } }),
    ),
  );
  return {
    progress,
    session,
    revise: () => {
      answers = { "backend.orm": "none" };
    },
  };
}

async function renderInterview(path = "/p/ledgerly/init?session=qa-init") {
  const view = renderRoute(path);
  await act(async () => {
    await view.router.load();
    await view.router.loadRouteChunk(view.router.routesById["/p/$projectId/init"]);
    await view.queryClient.ensureQueryData(queries.init("qa-init"));
  });
  return view;
}

describe("init recovery against PR27-shaped responses (component mocks, not live evidence)", () => {
  it("uses raw JSON only when a legacy server explicitly omits confirmed descriptors", async () => {
    const state = interview();
    server.use(
      http.get("http://matrix.test/v1/init/qa-init/progress", () => {
        const progress = state.progress();
        return HttpResponse.json({
          ...progress,
          answered: progress.answered.map(({ questionId, label, value }) => ({
            questionId,
            label,
            value,
          })),
        });
      }),
    );
    const user = userEvent.setup();
    await renderInterview();
    await user.click(await screen.findByRole("button", { name: "Edit answer: backend.orm" }));
    expect(
      screen.getByText(/Question metadata is unavailable from this server/),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "backend.orm" })).toHaveValue('"drizzle"');
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("does not allow clearing a confirmed server-described required list", async () => {
    const answers = { "business.goals": ["Keep customers"] };
    server.use(
      http.get("http://matrix.test/v1/init/qa-init", () =>
        HttpResponse.json({
          id: "qa-init",
          projectId: "ledgerly",
          answers,
          state: "in_progress",
          createdAt: "2026-10-12T00:00:00Z",
        }),
      ),
      http.get("http://matrix.test/v1/init/qa-init/progress", () =>
        HttpResponse.json(makeProgress(answers)),
      ),
    );
    const user = userEvent.setup();
    await renderInterview();
    await user.click(screen.getByRole("button", { name: "Edit answer: Business goals?" }));
    const input = screen.getByRole("textbox", { name: "Business goals?" });
    expect(input).toHaveValue("Keep customers");
    await user.clear(input);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByText("This question needs an answer.")).toBeInTheDocument();
  });

  it("edits confirmed answers with PATCH and announces dropped dependencies", async () => {
    const state = interview();
    let submitted: unknown;
    server.use(
      http.patch("http://matrix.test/v1/init/qa-init/answers/backend.orm", async ({ request }) => {
        submitted = await request.json();
        state.revise();
        return HttpResponse.json({
          session: state.session(),
          dropped: ["hosting.api"],
          progress: state.progress(),
        });
      }),
    );
    const user = userEvent.setup();
    await renderInterview();
    await user.click(await screen.findByRole("button", { name: "Edit answer: backend.orm" }));
    expect(screen.getByRole("radio", { name: /^Drizzle/ })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /^None/ }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(submitted).toEqual({ value: "none" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Previous answers invalidated by your change: hosting.api",
    );
    expect(
      screen.queryByRole("button", { name: "Edit answer: hosting.api" }),
    ).not.toBeInTheDocument();
  });

  it("does not resurrect dropped answers from a deferred pre-PATCH refetch", async () => {
    const state = interview();
    server.use(
      http.patch("http://matrix.test/v1/init/qa-init/answers/backend.orm", () => {
        state.revise();
        return HttpResponse.json({
          session: state.session(),
          dropped: ["hosting.api"],
          progress: state.progress(),
        });
      }),
    );
    const user = userEvent.setup();
    const { queryClient } = await renderInterview();
    await user.click(await screen.findByRole("button", { name: "Edit answer: backend.orm" }));
    const oldData = structuredClone(
      queryClient.getQueryData<Awaited<ReturnType<typeof endpoints.init>>>(
        queries.init("qa-init").queryKey,
      )!,
    );
    let resolveOld!: (value: typeof oldData) => void;
    const deferred = new Promise<typeof oldData>((resolve) => {
      resolveOld = resolve;
    });
    let signal: AbortSignal | undefined;
    const read = vi.spyOn(endpoints, "init").mockImplementationOnce((_sessionId, requestSignal) => {
      signal = requestSignal;
      return deferred;
    });
    try {
      const refetch = queryClient.refetchQueries({ queryKey: queries.init("qa-init").queryKey });
      await waitFor(() => expect(signal).toBeDefined());
      await user.click(screen.getByRole("radio", { name: /^None/ }));
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      expect(await screen.findByRole("status")).toHaveTextContent("Previous answers invalidated");
      expect(signal?.aborted).toBe(true);
      await act(async () => {
        resolveOld(oldData);
        await deferred;
        await refetch;
      });
      expect(queryClient.getQueryData(queries.init("qa-init").queryKey)).toMatchObject({
        session: { answers: { "backend.orm": "none" } },
      });
      expect(
        screen.queryByRole("button", { name: "Edit answer: hosting.api" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("hosting.api");
    } finally {
      resolveOld(oldData);
      read.mockRestore();
    }
  });

  it("refuses all mutation controls for a session on another project route, even for global admins", async () => {
    interview();
    await renderInterview("/p/wayline/init?session=qa-init");
    expect(await screen.findByRole("alert")).toHaveTextContent("belongs to a different project");
    expect(screen.queryByRole("button", { name: /^Edit answer:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Confirm/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save autonomy and continue" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate project" })).not.toBeInTheDocument();
  });

  it("clears a restored multiselect array using actual server revision validation", async () => {
    let answers = { "process.reviewLanes": ["correctness-security"] };
    const session = () => ({
      id: "qa-init",
      projectId: "ledgerly",
      answers,
      state: "in_progress",
      createdAt: "2026-10-12T00:00:00Z",
    });
    let submitted: unknown;
    server.use(
      http.get("http://matrix.test/v1/init/qa-init", () => HttpResponse.json(session())),
      http.get("http://matrix.test/v1/init/qa-init/progress", () =>
        HttpResponse.json(makeProgress(answers)),
      ),
      http.patch(
        "http://matrix.test/v1/init/qa-init/answers/process.reviewLanes",
        async ({ request }) => {
          const body = (await request.json()) as { value: unknown };
          submitted = body;
          const revised = serverReviseAnswer(answers, "process.reviewLanes", body.value);
          answers = { "process.reviewLanes": revised.answers["process.reviewLanes"] as string[] };
          return HttpResponse.json({
            session: session(),
            dropped: revised.dropped,
            progress: makeProgress(answers),
          });
        },
      ),
    );
    const user = userEvent.setup();
    const { queryClient } = await renderInterview();
    await user.click(
      await screen.findByRole("button", { name: "Edit answer: Review lanes on every change?" }),
    );
    expect(screen.queryByText(/Question metadata is unavailable/)).not.toBeInTheDocument();
    const checkbox = screen.getByRole("checkbox", { name: /^Correctness \+ security/ });
    expect(checkbox).toBeChecked();
    await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(submitted).toEqual({ value: [] }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Change answers" })).not.toBeInTheDocument(),
    );
    expect(queryClient.getQueryData(queries.init("qa-init").queryKey)).toMatchObject({
      session: { answers: { "process.reviewLanes": [] } },
    });
    expect(() => serverReviseAnswer(answers, "process.reviewLanes", ["invalid-lane"])).toThrow(
      "unknown invalid-lane",
    );
  });

  it("also discards an old focus refetch started while PATCH is pending", async () => {
    const state = interview();
    let releasePatch!: () => void;
    let started = false;
    const patchGate = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });
    server.use(
      http.patch("http://matrix.test/v1/init/qa-init/answers/backend.orm", async () => {
        started = true;
        await patchGate;
        state.revise();
        return HttpResponse.json({
          session: state.session(),
          dropped: ["hosting.api"],
          progress: state.progress(),
        });
      }),
    );
    const user = userEvent.setup();
    const { queryClient } = await renderInterview();
    await user.click(await screen.findByRole("button", { name: "Edit answer: backend.orm" }));
    const oldData = structuredClone(
      queryClient.getQueryData<Awaited<ReturnType<typeof endpoints.init>>>(
        queries.init("qa-init").queryKey,
      )!,
    );
    expect(screen.getByRole("radio", { name: /^Drizzle/ })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /^None/ }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(started).toBe(true));
    let resolveOld!: (value: typeof oldData) => void;
    const deferred = new Promise<typeof oldData>((resolve) => {
      resolveOld = resolve;
    });
    const read = vi.spyOn(endpoints, "init").mockReturnValueOnce(deferred);
    try {
      const refetch = queryClient.refetchQueries({ queryKey: queries.init("qa-init").queryKey });
      await waitFor(() => expect(read).toHaveBeenCalled());
      releasePatch();
      expect(await screen.findByRole("status")).toHaveTextContent("Previous answers invalidated");
      await act(async () => {
        resolveOld(oldData);
        await deferred;
        await refetch;
      });
      expect(queryClient.getQueryData(queries.init("qa-init").queryKey)).toMatchObject({
        session: { answers: { "backend.orm": "none" } },
      });
      expect(
        screen.queryByRole("button", { name: "Edit answer: hosting.api" }),
      ).not.toBeInTheDocument();
    } finally {
      releasePatch();
      resolveOld(oldData);
      read.mockRestore();
    }
  });

  it("uses one atomic policy PUT and preserves the failure until explicit retry", async () => {
    interview();
    let calls = 0;
    let etag: string | null = null;
    let body: unknown;
    server.use(
      http.put("http://matrix.test/v1/projects/ledgerly/autonomy-policy", async ({ request }) => {
        calls += 1;
        etag = request.headers.get("if-match");
        body = await request.json();
        return HttpResponse.json(
          { error: { code: "precondition_failed", message: "changed" } },
          { status: 412 },
        );
      }),
    );
    const user = userEvent.setup();
    await renderInterview();
    const save = await screen.findByRole("button", { name: "Save autonomy and continue" });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    expect(await screen.findByRole("alert")).toHaveTextContent("Autonomy changed on the server");
    expect(calls).toBe(1);
    expect(etag).toBe('"project-v1"');
    expect(body).toMatchObject({ autonomy: { merge: "human", compound: "autonomous" } });
    expect(screen.queryByRole("heading", { name: "Generate the project" })).not.toBeInTheDocument();
  });

  it("shows actual artifacts only when finalize returns result.ok", async () => {
    const state = interview();
    server.use(
      http.put("http://matrix.test/v1/projects/ledgerly/autonomy-policy", () =>
        HttpResponse.json(mockDb().projects[0]),
      ),
      http.post("http://matrix.test/v1/init/qa-init/finalize", () =>
        HttpResponse.json({
          ...state.session(),
          state: "completed",
          result: {
            status: "ok",
            files: ["matrix.config.ts", "docs/adr/0001.md"],
            tickets: ["qa-ticket"],
            warnings: [],
          },
        }),
      ),
    );
    const user = userEvent.setup();
    await renderInterview();
    const save = await screen.findByRole("button", { name: "Save autonomy and continue" });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await user.click(await screen.findByRole("button", { name: "Generate project" }));
    expect(await screen.findByRole("status")).toHaveTextContent("docs/adr/0001.md");
    expect(screen.getByRole("link", { name: "Open project board" })).toHaveAttribute(
      "href",
      "/p/ledgerly/board",
    );
  });

  it("reuses both creation keys when init fails after project creation", async () => {
    const projectKeys: (string | null)[] = [];
    const initKeys: (string | null)[] = [];
    server.use(
      http.post("http://matrix.test/v1/projects", ({ request }) => {
        projectKeys.push(request.headers.get("idempotency-key"));
        return HttpResponse.json({ ...mockDb().projects[0], id: "qa-project", name: "qa-retry" });
      }),
      http.post("http://matrix.test/v1/projects/qa-project/init", ({ request }) => {
        initKeys.push(request.headers.get("idempotency-key"));
        return HttpResponse.json(
          { error: { code: "unavailable", message: "retry later" } },
          { status: 503 },
        );
      }),
    );
    const user = userEvent.setup();
    renderRoute("/new");
    await user.type(await screen.findByPlaceholderText("ledgerly"), "qa-retry");
    const submit = screen.getByRole("button", { name: "Create and start the interview" });
    await user.click(submit);
    await screen.findByRole("alert");
    await user.click(submit);
    await waitFor(() => expect(initKeys).toHaveLength(2));
    expect(projectKeys[0]).toBeTruthy();
    expect(projectKeys[1]).toBe(projectKeys[0]);
    expect(initKeys[1]).toBe(initKeys[0]);
    expect(initKeys[0]).not.toBe(projectKeys[0]);
  });
});
