import { describe, expect, test } from "vitest";
import { hasAbsenceClaim, parseScenarioBatch, parseScenarios } from "./holdout.js";

describe("absence-claim detection", () => {
  test.each([
    'the screen shows the message "No eligible photos, add some"',
    "the screen shows an empty-state message no eligible photos, add some",
    "the gallery displays no eligible photos, add some",
    "the empty state reads: no photos yet",
    "renders the label 'Nothing here, no trips yet'",
    "a toast says no connection",
    "the screen shows an error message that says no internet, try again",
    "the screen shows “No results” and a retry button",
  ])("displayed copy is a presence claim: %s", (then) => {
    expect(hasAbsenceClaim(then)).toBe(false);
  });

  test.each([
    "no network request is made",
    "the photo is not uploaded",
    "the photo isn't uploaded to the server",
    "shows the empty state and no network request is made",
    'shows "No photos" and the file is not modified',
    "no error message is shown",
    "the app does not show the paywall",
    "state remains unchanged",
    "returns 5 and produces no observable I/O",
    "never calls the API",
    "the message is never sent",
    "the caption is not rendered",
    "the label text stays unchanged",
    "the screen displays the gallery without calling the network",
    "renders the list with no network requests",
    "the request is not made",
    "nothing is uploaded",
    "it does not leak the secret",
    "shows no photos and nothing is uploaded",
    "shows nothing is uploaded",
    "displays no request is sent",
  ])("true absence claim still requires instrumentation: %s", (then) => {
    expect(hasAbsenceClaim(then)).toBe(true);
  });
});

const scenario = (id: string, then: string) => ({
  id,
  given: "a user",
  when: "they open it",
  then,
});

describe("scenario batches", () => {
  test("empty-state copy with negations passes validation", () => {
    expect(
      parseScenarios(
        JSON.stringify([
          scenario("s1", "the screen shows an empty-state message no eligible photos, add some"),
        ]),
      ),
    ).toHaveLength(1);
  });

  test("an uninstrumented absence claim is dropped when enough valid scenarios remain", () => {
    const batch = parseScenarioBatch(
      JSON.stringify([
        scenario("s1", "shows the title Trips"),
        scenario("s2", "the photo is not uploaded"),
        scenario("s3", "shows a list of 3 trips"),
        scenario("s4", 'shows "No eligible photos, add some"'),
      ]),
    );
    expect(batch.scenarios.map((s) => s.id)).toEqual(["s1", "s3", "s4"]);
    expect(batch.dropped).toEqual(["absence claim requires an instrumentable assertion"]);
  });

  test("the batch is rejected when too few valid scenarios remain", () => {
    expect(() =>
      parseScenarioBatch(
        JSON.stringify([
          scenario("s1", "shows the title Trips"),
          scenario("s2", "the photo is not uploaded"),
          scenario("s3", "shows a list of 3 trips"),
        ]),
      ),
    ).toThrow("absence claim requires an instrumentable assertion");
  });

  test("instrumented absence claims are kept", () => {
    const then = "spy on fetch before render and assert zero intercepted calls; no request is made";
    expect(parseScenarios(JSON.stringify([scenario("s1", then)]))).toHaveLength(1);
  });
});
