import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ErrorState } from "@/components/ui/states";
import { ApiError, toApiError, unwrap } from "./http";

test("tracker error body, not statusText, reaches the existing dashboard error renderer", async () => {
  const message =
    "Beads tracker unavailable: required binary bd is missing. Install bd on the server, or choose the markdown or github tracker.";
  const response = new Response(
    JSON.stringify({ error: { code: "tracker_unavailable", message } }),
    {
      status: 503,
      statusText: "Internal Server Error",
      headers: { "content-type": "application/json" },
    },
  );
  const error = await toApiError(response);
  expect(error).toBeInstanceOf(ApiError);
  expect(error.message).toBe(message);
  await expect(unwrap(Promise.resolve({ response }))).rejects.toMatchObject({
    status: 503,
    code: "tracker_unavailable",
    message,
  });
  render(<ErrorState error={error} onRetry={() => {}} />);
  expect(screen.getByRole("alert")).toHaveTextContent(message);
  expect(screen.queryByText("Internal Server Error")).not.toBeInTheDocument();
});
