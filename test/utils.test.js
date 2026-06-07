import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLogin, parseCsvLine, unique } from "../server/utils.js";

test("normalizeLogin trims @ prefix and lowercases", () => {
  assert.equal(normalizeLogin(" @OctoCat "), "octocat");
});

test("parseCsvLine accepts comma and newline separated values", () => {
  assert.deepEqual(parseCsvLine("alice,bob\ncarol"), ["alice", "bob", "carol"]);
});

test("unique removes duplicates and empty values", () => {
  assert.deepEqual(unique(["a", "", "a", "b"]), ["a", "b"]);
});
