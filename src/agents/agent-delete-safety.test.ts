import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { findOverlappingWorkspaceAgentIds, isSharedAuthStoreOwner } from "./agent-delete-safety.js";

describe("shared auth store deletion safety", () => {
  const sharedAuthDbPath = path.join(os.tmpdir(), "shared-auth", "openclaw-agent.sqlite");
  const otherAgentAuthDbPath = path.join(os.tmpdir(), "other-auth", "openclaw-agent.sqlite");

  it.each([
    {
      name: "blocks the legacy-main database owner",
      ownership: { location: "legacy-main" } as const,
      agentAuthDbPath: sharedAuthDbPath,
      expected: true,
    },
    {
      name: "allows a non-owner agent database",
      ownership: { location: "legacy-main" } as const,
      agentAuthDbPath: otherAgentAuthDbPath,
      expected: false,
    },
    {
      name: "follows state-db ownership instead of a legacy-main path match",
      ownership: { location: "state-db" } as const,
      agentAuthDbPath: sharedAuthDbPath,
      expected: false,
    },
  ])("$name", ({ ownership, agentAuthDbPath, expected }) => {
    expect(isSharedAuthStoreOwner({ ownership, agentAuthDbPath, sharedAuthDbPath })).toBe(expected);
  });
});

describe("findOverlappingWorkspaceAgentIds", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  function makeTempWorkspace(name: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    tempRoots.push(root);
    return fs.realpathSync.native(root);
  }

  function configWithWorkspaces(workspaces: Record<string, string>): OpenClawConfig {
    return {
      agents: {
        entries: Object.fromEntries(
          Object.entries(workspaces).map(([id, workspace]) => [id, { workspace }]),
        ),
      },
    } as unknown as OpenClawConfig;
  }

  it("flags a symlinked workspace that resolves into another agent's workspace", () => {
    const shared = makeTempWorkspace("delete-safety-shared");
    const link = path.join(makeTempWorkspace("delete-safety-link"), "linked");
    // Junctions keep this reachable on Windows without elevated symlink rights.
    fs.symlinkSync(shared, link, "junction");

    const cfg = configWithWorkspaces({
      alpha: shared,
      beta: link,
    });

    expect(findOverlappingWorkspaceAgentIds(cfg, "beta", link)).toEqual(["alpha"]);
  });

  function mockRealpathError(code: string): void {
    vi.spyOn(fs.realpathSync, "native").mockImplementation(() => {
      throw Object.assign(new Error(`simulated realpath failure (${code})`), { code });
    });
  }

  it("reports overlap when an existing workspace path cannot be realpath-resolved", () => {
    const alpha = makeTempWorkspace("delete-safety-alpha");
    const beta = makeTempWorkspace("delete-safety-beta");
    const cfg = configWithWorkspaces({ alpha, beta });

    mockRealpathError("EACCES");

    // Both directories exist but their symlink relationship can no longer be
    // proven; deletion must fail closed instead of trusting lexical inequality.
    expect(findOverlappingWorkspaceAgentIds(cfg, "beta", beta)).toEqual(["alpha"]);
  });

  it("fails closed for symlink-loop and other non-missing realpath errors", () => {
    const alpha = makeTempWorkspace("delete-safety-loop-a");
    const beta = makeTempWorkspace("delete-safety-loop-b");
    const cfg = configWithWorkspaces({ alpha, beta });

    for (const code of ["ELOOP", "EPERM", "EIO"]) {
      mockRealpathError(code);
      expect(findOverlappingWorkspaceAgentIds(cfg, "beta", beta)).toEqual(["alpha"]);
    }
  });

  it("keeps lexical comparison only for missing-path realpath errors", () => {
    const left = makeTempWorkspace("delete-safety-miss-a");
    const right = makeTempWorkspace("delete-safety-miss-b");
    const missingLeft = path.join(makeTempWorkspace("delete-safety-gone-a"), "gone-left");
    const missingRight = path.join(makeTempWorkspace("delete-safety-gone-b"), "gone-right");
    const cfg = configWithWorkspaces({ alpha: left, beta: right });
    const goneCfg = configWithWorkspaces({ alpha: missingLeft, beta: missingRight });

    mockRealpathError("ENOENT");
    expect(findOverlappingWorkspaceAgentIds(cfg, "beta", right)).toEqual([]);

    // Genuinely absent directories keep the pre-existing lexical comparison too.
    expect(findOverlappingWorkspaceAgentIds(goneCfg, "beta", missingRight)).toEqual([]);
  });
});
