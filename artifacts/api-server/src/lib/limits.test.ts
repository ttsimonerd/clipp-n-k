/**
 * Unit tests for lib/limits.ts — the pure role-aware limit resolution.
 *
 * No DB access is exercised: resolveQuotaBytes / resolveUploadBytes take the
 * (already-loaded) role config as a parameter, so these tests cover the
 * precedence rules in isolation.
 */
import { describe, it, expect, vi } from "vitest";

// limits.ts imports the DB client (for getRoleConfig) and github.ts (for the
// star-bonus constant); mock both so this pure-logic test needs no env/DB.
vi.mock("@workspace/db", () => ({
  db: {},
  discordRolesTable: {},
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resolveQuotaBytes, resolveUploadBytes } from "./limits";
import { STAR_BONUS_BYTES } from "./github";

const GB = 1_073_741_824;
const MB = 1_048_576;

// Minimal role-config rows (only the fields the resolver reads).
const role = (over: {
  roleId: string;
  priority: number;
  maxUploadBytes?: number | null;
  maxUserStorageBytes?: number | null;
}) => ({
  roleId: over.roleId,
  roleName: over.roleId,
  priority: over.priority,
  maxUploadBytes: over.maxUploadBytes ?? null,
  maxUserStorageBytes: over.maxUserStorageBytes ?? null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe("resolveUploadBytes", () => {
  const settings = { maxUploadBytes: 100 * MB };

  it("falls back to the site default when the user has no configured roles", () => {
    expect(resolveUploadBytes(settings, [], [])).toBe(100 * MB);
    expect(resolveUploadBytes(settings, [role({ roleId: "a", priority: 1, maxUploadBytes: 500 * MB })], ["other"])).toBe(100 * MB);
  });

  it("uses the role's upload limit when the user holds that role", () => {
    const cfg = [role({ roleId: "vip", priority: 1, maxUploadBytes: 500 * MB })];
    expect(resolveUploadBytes(settings, cfg, ["vip"])).toBe(500 * MB);
  });

  it("picks the highest-priority role when the user holds several", () => {
    const cfg = [
      role({ roleId: "member", priority: 1, maxUploadBytes: 200 * MB }),
      role({ roleId: "vip", priority: 10, maxUploadBytes: 999 * MB }),
    ];
    expect(resolveUploadBytes(settings, cfg, ["member", "vip"])).toBe(999 * MB);
  });

  it("inherits the site default when the highest-priority role leaves upload null", () => {
    const cfg = [
      role({ roleId: "member", priority: 1, maxUploadBytes: 200 * MB }),
      role({ roleId: "vip", priority: 10, maxUploadBytes: null }),
    ];
    expect(resolveUploadBytes(settings, cfg, ["member", "vip"])).toBe(100 * MB);
  });
});

describe("resolveQuotaBytes", () => {
  const settings = { maxUserStorageBytes: 5 * GB };

  it("uses the site default with no roles, override, or bonus", () => {
    expect(
      resolveQuotaBytes(settings, [], {
        githubStarBonusGranted: false,
        quotaOverrideBytes: null,
        roles: [],
      }),
    ).toBe(5 * GB);
  });

  it("adds the star bonus on top of the site default", () => {
    expect(
      resolveQuotaBytes(settings, [], {
        githubStarBonusGranted: true,
        quotaOverrideBytes: null,
        roles: [],
      }),
    ).toBe(5 * GB + STAR_BONUS_BYTES);
  });

  it("uses the highest-priority role's storage limit", () => {
    const cfg = [
      role({ roleId: "member", priority: 1, maxUserStorageBytes: 2 * GB }),
      role({ roleId: "vip", priority: 10, maxUserStorageBytes: 50 * GB }),
    ];
    expect(
      resolveQuotaBytes(settings, cfg, {
        githubStarBonusGranted: false,
        quotaOverrideBytes: null,
        roles: ["member", "vip"],
      }),
    ).toBe(50 * GB);
  });

  it("lets an admin override win over both role and site defaults", () => {
    const cfg = [role({ roleId: "vip", priority: 10, maxUserStorageBytes: 50 * GB })];
    expect(
      resolveQuotaBytes(settings, cfg, {
        githubStarBonusGranted: false,
        quotaOverrideBytes: 1 * GB,
        roles: ["vip"],
      }),
    ).toBe(1 * GB);
  });

  it("still adds the star bonus on top of an override", () => {
    expect(
      resolveQuotaBytes(settings, [], {
        githubStarBonusGranted: true,
        quotaOverrideBytes: 1 * GB,
        roles: [],
      }),
    ).toBe(1 * GB + STAR_BONUS_BYTES);
  });

  it("treats a null quota override as 'not set'", () => {
    expect(
      resolveQuotaBytes(settings, [], {
        githubStarBonusGranted: false,
        quotaOverrideBytes: null,
        roles: [],
      }),
    ).toBe(5 * GB);
  });
});
