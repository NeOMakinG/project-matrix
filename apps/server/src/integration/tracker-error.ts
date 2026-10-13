import { CoreError } from "../core-port.js";

export class TrackerUnavailableError extends CoreError {
  constructor(readonly reason: "missing" | "failed" | "timeout") {
    super(
      "tracker_unavailable",
      reason === "missing"
        ? "Beads tracker unavailable: required binary bd is missing. Install bd on the server, or choose the markdown or github tracker."
        : reason === "timeout"
          ? "Beads tracker initialization timed out using bd. Check the server's bd installation, or choose the markdown or github tracker."
          : "Beads tracker initialization failed using bd. Check the server's bd installation, or choose the markdown or github tracker.",
    );
    this.name = "TrackerUnavailableError";
  }
}
