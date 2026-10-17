import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { ComingSoon, PACKAGE_NAME } from "../src/index.js";

describe("@codecoach/ui", () => {
  test("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@codecoach/ui");
  });

  test("renders the placeholder panel", () => {
    const html = renderToStaticMarkup(<ComingSoon />);
    expect(html).toContain("CodeCoach is coming soon");
    expect(html).toContain('data-core="@codecoach/core"');
  });
});
