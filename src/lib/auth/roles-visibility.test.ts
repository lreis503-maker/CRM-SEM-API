import { describe, expect, it } from "vitest";
import { canManageMonthlyPayments, seesAllConversations } from "./roles";

describe("seesAllConversations", () => {
  it("lets owner, admin and viewer see every conversation", () => {
    expect(seesAllConversations("owner")).toBe(true);
    expect(seesAllConversations("admin")).toBe(true);
    expect(seesAllConversations("viewer")).toBe(true);
  });

  it("limits a seller to their own leads", () => {
    expect(seesAllConversations("agent")).toBe(false);
  });
});

describe("canManageMonthlyPayments", () => {
  it("shows monthly payment management only to owner and admin", () => {
    expect(canManageMonthlyPayments("owner")).toBe(true);
    expect(canManageMonthlyPayments("admin")).toBe(true);
    expect(canManageMonthlyPayments("agent")).toBe(false);
    expect(canManageMonthlyPayments("viewer")).toBe(false);
  });
});
