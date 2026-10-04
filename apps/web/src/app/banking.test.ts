import { describe, expect, it } from "vitest";
import { bankDate, bankIssueMessage, connectionStatus, importStartDate, reviewReason } from "./banking";

describe("banking presentation", () => {
  it("defaults new connections to the user's current calendar date", () => {
    expect(importStartDate(new Date(2027, 0, 2, 23, 59))).toBe("2027-01-02");
    expect(importStartDate(new Date(2027, 10, 12))).toBe("2027-11-12");
  });
  it("uses readable connection and review labels", () => {
    expect(connectionStatus.needs_reconnect).toBe("Reconnect required");
    expect(connectionStatus.select_accounts).toBe("Choose accounts");
    expect(reviewReason.overlap).toBe("Possible duplicate");
    expect(reviewReason.invalid).toBe("Unable to import");
  });
  it("explains unsupported activity without presenting raw provider codes", () => {
    for (const code of ["UNSUPPORTED_CURRENCY", "INVALID_CENT_PRECISION", "ZERO_AMOUNT", "INVALID_FIELDS: amount", "UNKNOWN"]) {
      expect(bankIssueMessage(code)).not.toContain(code);
      expect(bankIssueMessage(code)).toMatch(/cannot be imported|not been imported/);
    }
    expect(bankIssueMessage("INVALID_CENT_PRECISION")).toContain("without changing the amount");
  });
  it("formats provider calendar dates without moving them into another day", () => {
    expect(bankDate("2027-01-02")).toBe(new Date("2027-01-02T00:00:00Z").toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" }));
  });
});
