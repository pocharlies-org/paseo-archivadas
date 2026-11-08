import assert from "node:assert/strict";
import { test } from "node:test";
import { conAlfa } from "../shared/color.ts";

test("conAlfa turns a hex color into an rgba with that alpha", () => {
  assert.equal(conAlfa("#f59e0b", 0.1), "rgba(245, 158, 11, 0.1)");
  assert.equal(conAlfa("#fb0", 0.5), "rgba(255, 187, 0, 0.5)");
  assert.equal(conAlfa(" #FFFFFF ", 1), "rgba(255, 255, 255, 1)");
});

test("conAlfa gives null for a color it cannot split, so the caller picks a flat fallback", () => {
  assert.equal(conAlfa("rgb(1, 2, 3)", 0.1), null);
  assert.equal(conAlfa("goldenrod", 0.1), null);
  assert.equal(conAlfa("#12345", 0.1), null);
});
