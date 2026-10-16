import { describe, expect, it } from "vitest";
import { compareNames, compareToHolders, nameTokens, placesMatch, skeleton } from "../utils/nameMatch.js";

describe("name matching", () => {
  it("NM-1: the same Latin name in different case, spacing and punctuation matches", () => {
    expect(compareNames("Murugan", "MURUGAN")).toBe("match");
    expect(compareNames("A. Murugan", "A Murugan")).toBe("match");
    expect(compareNames("  Kandasamy   Murugan ", "Murugan Kandasamy")).toBe("match"); // order-insensitive
  });

  it("NM-2: Tamil and Latin spellings of one name match", () => {
    expect(compareNames("முருகன்", "Murugan")).toBe("match");
    expect(compareNames("கந்தசாமி", "Kandasamy")).toBe("match");
    expect(compareNames("Murugan Kandasamy", "முருகன் கந்தசாமி")).toBe("match");
    expect(compareNames("Subramanian", "Subramaniam")).toBe("match");
  });

  it("NM-3: honorifics and a 'son of' suffix are ignored", () => {
    expect(compareNames("Thiru. Murugan S/o Kandasamy", "Murugan")).toBe("match");
    expect(compareNames("Tmt. Lakshmi W/o Murugan", "Lakshmi")).toBe("match");
    expect(nameTokens("Mr Raja D/o Selvam")).toEqual(["raja"]);
  });

  it("NM-4: an initial matches the full name that starts with it", () => {
    expect(compareNames("S. Murugan", "Subramanian Murugan")).toBe("match");
    expect(compareNames("R. Murugan", "S. Murugan")).not.toBe("match");
  });

  it("NM-5: a different person is a mismatch", () => {
    expect(compareNames("Murugan", "Selvam")).toBe("mismatch");
    expect(compareNames("முருகன்", "Selvam")).toBe("mismatch");
    expect(compareNames("Lakshmi Devi", "Ramasamy Pillai")).toBe("mismatch");
  });

  it("NM-6: one extra or one different token is partial, for a person to look at", () => {
    expect(compareNames("Murugan", "Murugan Kandasamy")).toBe("partial");
    expect(compareNames("Murugan Kandasamy", "Murugan Selvam")).toBe("partial");
  });

  it("NM-7: empty or unusable input is null, not a mismatch", () => {
    expect(compareNames("", "Murugan")).toBeNull();
    expect(compareNames(null, undefined)).toBeNull();
    expect(compareNames("Mr.", "Murugan")).toBeNull();
  });

  it("NM-8: any one matching holder is enough", () => {
    expect(compareToHolders(["Selvam", "Murugan S/o Kandasamy"], "முருகன்")).toBe("match");
    expect(compareToHolders(["Selvam", "Ravi"], "Murugan")).toBe("mismatch");
    expect(compareToHolders([], "Murugan")).toBeNull();
  });

  it("NM-9: skeletons ignore vowels, merge voiced pairs and collapse doubles", () => {
    expect(skeleton("Murugan")).toBe(skeleton("முருகன்"));
    expect(skeleton("Pattu")).toBe(skeleton("Badu"));
    expect(skeleton("")).toBe("");
  });

  it("NM-10: place names compare across scripts and spellings", () => {
    expect(placesMatch("Thanjavur", "தஞ்சாவூர்")).toBe(true);
    expect(placesMatch("Tanjore", "Thanjavur")).toBe(true);
    expect(placesMatch("Madurai", "Chennai")).toBe(false);
    expect(placesMatch("", "Madurai")).toBeNull();
  });
});
