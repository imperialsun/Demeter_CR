import { describe, expect, it } from "vitest";

import { getPasswordStrength } from "@/lib/password-strength";

describe("getPasswordStrength", () => {
  it("reports an empty password as empty", () => {
    const strength = getPasswordStrength("   ");

    expect(strength).toEqual({
      score: 0,
      label: "Vide",
      hint: "Saisissez un mot de passe.",
    });
  });

  it("scales a weak password up when it gains length and diversity", () => {
    expect(getPasswordStrength("abc").score).toBe(1);
    expect(getPasswordStrength("abcdefgh").score).toBe(2);
    expect(getPasswordStrength("abcd1234").score).toBe(2);
  });

  it("reaches the highest level for a long password with enough diversity", () => {
    const strength = getPasswordStrength("Abcd1234!xyz");

    expect(strength.score).toBe(4);
    expect(strength.label).toBe("Très fort");
  });
});
