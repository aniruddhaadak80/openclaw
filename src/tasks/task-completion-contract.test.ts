import { describe, expect, it } from "vitest";
import {
  resolveRequiredCompletionDeliveryFailureTerminalResult,
  resolveRequiredCompletionTerminalResult,
} from "./task-completion-contract.js";

describe("task completion delivery failures", () => {
  it("keeps the bounded failure reason UTF-16 well-formed", () => {
    const result = resolveRequiredCompletionDeliveryFailureTerminalResult(
      `${"x".repeat(158)}🚀tail`,
    );
    expect(result.terminalSummary).toContain(`${"x".repeat(158)}...`);
  });
});

describe("resolveRequiredCompletionTerminalResult", () => {
  it("returns empty for a complete final report", () => {
    expect(
      resolveRequiredCompletionTerminalResult("Here is the final summary of the changes."),
    ).toEqual({});
  });
  it("blocks when result is empty", () => {
    expect(
      resolveRequiredCompletionTerminalResult("").terminalOutcome,
    ).toBe("blocked");
  });
  it("blocks when result is null", () => {
    expect(
      resolveRequiredCompletionTerminalResult(null).terminalOutcome,
    ).toBe("blocked");
  });
  it("detects complete report without space after period", () => {
    expect(
      resolveRequiredCompletionTerminalResult("I have finished the analysis.The results show improvement."),
    ).toEqual({});
  });
  it("detects complete report with colon no space", () => {
    expect(
      resolveRequiredCompletionTerminalResult("The config needs updating:here are the changes."),
    ).toEqual({});
  });
  it("blocks progress-only text with no-space-after-period", () => {
    expect(
      resolveRequiredCompletionTerminalResult("I will now start analyzing the codebase.").terminalOutcome,
    ).toBe("blocked");
  });
  it("detects complete report after progress prefix with no-space-after-period", () => {
    expect(
      resolveRequiredCompletionTerminalResult("I will start by mapping the repo.The final deliverable is complete and ready."),
    ).toEqual({});
  });
});
