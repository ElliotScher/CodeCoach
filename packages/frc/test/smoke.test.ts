import { describe, expect, test } from "vitest";

import { DEPENDS_ON, PACKAGE_NAME } from "../src/index.js";

describe("@codecoach/frc", () => {
  test("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@codecoach/frc");
  });

  test("resolves its workspace dependencies", () => {
    expect(DEPENDS_ON).toEqual(["@codecoach/core"]);
  });
});
