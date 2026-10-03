import { describe, expect, it } from "vitest";
import { authEnvironment } from "./environment";

describe("private production authentication", () => {
  it("retains local signup and Mailpit guidance", () => {
    const local = authEnvironment(true);
    expect(local.allowSignup).toBe(true);
    expect(local.resetMessage).toContain("Mailpit");
    expect(local.configurationMessage).toContain(".env.local");
  });

  it("disables hosted signup and uses hosted recovery/configuration guidance", () => {
    const hosted = authEnvironment(false);
    expect(hosted.allowSignup).toBe(false);
    expect(hosted.resetMessage).not.toContain("Mailpit");
    expect(hosted.resetMessage).toContain("If your account");
    expect(hosted.configurationMessage).toContain("rebuild");
    expect(hosted.configurationMessage).not.toContain(".env.local");
  });
});
