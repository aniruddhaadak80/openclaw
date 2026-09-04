// Docker package identity tests cover per-manager exact version proof.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";
const ROOT_DIR = process.cwd();
const PRELUDE = [
  `source "${path.join(ROOT_DIR, "scripts/docker/install-sh-common/version-parse.sh")}"`,
  `source "${path.join(ROOT_DIR, "scripts/e2e/lib/docker-package-identity.sh")}"`,
].join("\n");

function checkIdentity(expected: string, manifest: string, cli: string, manager = "npm") {
  return spawnSync(
    BASH_BIN,
    [
      "-c",
      `${PRELUDE}\nassert_docker_package_manager_identity "$EXPECTED_VERSION" "$MANIFEST_VERSION" "$CLI_OUTPUT" "$MANAGER"`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        EXPECTED_VERSION: expected,
        MANIFEST_VERSION: manifest,
        CLI_OUTPUT: cli,
        MANAGER: manager,
      },
    },
  );
}

describe("assert_docker_package_manager_identity", () => {
  it("rejects a stale CLI that merely contains the expected version as a substring", () => {
    // Regression for #127415: "OpenClaw 11.2.30 (wrong)" passed for expected "1.2.3".
    const result = checkIdentity("1.2.3", "1.2.3", "OpenClaw 11.2.30 (wrong)");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("parses to '11.2.30'");
  });

  it("rejects a manager manifest mismatch even when the CLI matches", () => {
    const result = checkIdentity("1.2.3", "1.2.4", "OpenClaw 1.2.3", "pnpm");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("[pnpm] installed manifest version '1.2.4'");
  });

  it("rejects unparseable CLI output", () => {
    const result = checkIdentity("1.2.3", "1.2.3", "starting service...");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("<unparseable>");
  });

  it("accepts exact manifest and CLI identity, including prerelease builds", () => {
    expect(checkIdentity("1.2.3", "1.2.3", "OpenClaw 1.2.3").status).toBe(0);
    expect(
      checkIdentity(
        "2026.6.21-beta.1+build.7",
        "2026.6.21-beta.1+build.7",
        "OpenClaw v2026.6.21-beta.1+build.7",
        "bun",
      ).status,
    ).toBe(0);
  });
});
