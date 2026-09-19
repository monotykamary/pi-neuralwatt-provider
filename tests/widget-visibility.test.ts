import { describe, expect, it } from "vitest";
import { shouldShowNeuralwattFooter } from "../index";

// Footer visibility contract: selecting a Neuralwatt model is enough to show
// the line (no turn required), hideOnOtherProvider (default true) hides it on
// any other provider, and session data only keeps it alive on another provider
// when that opt-out is explicitly disabled.
describe("neuralwatt footer visibility", () => {
  const base = { hasSessionData: false, activeProvider: undefined as string | undefined, hideOnOtherProvider: true };

  it("shows as soon as a Neuralwatt model is selected, before any turn", () => {
    expect(shouldShowNeuralwattFooter({ ...base, activeProvider: "neuralwatt" })).toBe(true);
  });

  it("hides on another provider by default, even with session data", () => {
    expect(shouldShowNeuralwattFooter({ ...base, hasSessionData: true, activeProvider: "anthropic" })).toBe(false);
  });

  it("keeps showing on another provider when hideOnOtherProvider is disabled", () => {
    expect(
      shouldShowNeuralwattFooter({ hasSessionData: true, activeProvider: "anthropic", hideOnOtherProvider: false }),
    ).toBe(true);
  });

  it("stays hidden on another provider without data when the opt-out is disabled", () => {
    expect(
      shouldShowNeuralwattFooter({ hasSessionData: false, activeProvider: "anthropic", hideOnOtherProvider: false }),
    ).toBe(false);
  });

  it("hides before any model is selected", () => {
    expect(shouldShowNeuralwattFooter({ ...base })).toBe(false);
  });
});
