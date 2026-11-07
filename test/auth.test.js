import test from "node:test";
import assert from "node:assert/strict";
import { isAuthorized } from "../src/auth.js";

test("accepts the correct bearer key", () => {
  assert.equal(isAuthorized({headers:{authorization:"Bearer secret"}}, "secret"), true);
});
test("rejects missing and incorrect keys", () => {
  assert.equal(isAuthorized({headers:{}}, "secret"), false);
  assert.equal(isAuthorized({headers:{authorization:"Bearer nope"}}, "secret"), false);
});
test("rejects all keys when server key is unset", () => {
  assert.equal(isAuthorized({headers:{authorization:"Bearer x"}}, ""), false);
});
