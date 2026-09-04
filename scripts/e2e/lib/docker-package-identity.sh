#!/usr/bin/env bash
# Canonical per-manager package identity check for Docker package-acceptance.
# Requires extract_openclaw_semver from
# scripts/docker/install-sh-common/version-parse.sh (source it first).
#
# Substring matching lets a stale CLI such as "OpenClaw 11.2.30 (wrong)" pass
# for an expected "1.2.3", and copying one manager's manifest version as every
# manager's evidence masks missing proof (see #127415). Compare each manager's
# own installed manifest exactly, then require its CLI output to parse to the
# same exact version.

assert_docker_package_manager_identity() {
  local expected_version="$1"
  local manifest_version="$2"
  local cli_output="$3"
  local manager="$4"
  if [[ "$manifest_version" != "$expected_version" ]]; then
    echo "[$manager] installed manifest version '$manifest_version' != expected '$expected_version'" >&2
    return 1
  fi
  local parsed_version
  parsed_version="$(extract_openclaw_semver "$cli_output")"
  if [[ "$parsed_version" != "$expected_version" ]]; then
    echo "[$manager] CLI output parses to '${parsed_version:-<unparseable>}' (raw: '$cli_output'), expected '$expected_version'" >&2
    return 1
  fi
}
