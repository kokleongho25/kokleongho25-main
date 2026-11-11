import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/**
 * `http.request` and `https.request` validate `options.method` with `checkIsHttpToken`
 * before they build the request, so a literal outside the token set throws
 * `ERR_INVALID_HTTP_TOKEN` from the call itself and no request exists.
 *
 * Measured on Node 24.22.1: `"GET"`, `"get"`, `"M-SEARCH"`, `"X"` and the punctuation set
 * `"!#$%&'*+-.^_`|~"` all construct a request; `"BAD METHOD"`, `"G/ET"`, `"G:ET"`,
 * `"G,ET"`, `"GET "`, `" "` and `"GéT"` throw. An empty string is accepted, because Node
 * reads `""` as "not given" and falls back to `GET`.
 */
const requestsFor = (body: string) =>
  analyzeJavaScriptSemantics(
    `import http from "node:http";\nimport https from "node:https";\nfunction f() { ${body}; }`,
  ).requestOperations;

it.each([
  [`http.request({ host: "h", path: "/", method: "BAD METHOD" })`],
  [`http.request({ host: "h", path: "/", method: "G/ET" })`],
  [`http.request({ host: "h", path: "/", method: "G:ET" })`],
  [`http.request({ host: "h", path: "/", method: "GET " })`],
  [`http.request({ host: "h", path: "/", method: " " })`],
  [`http.request({ host: "h", path: "/", method: "GéT" })`],
  [`https.request({ host: "h", path: "/", method: "BAD METHOD" })`],
  [`http.get({ host: "h", path: "/", method: "BAD METHOD" })`],
] as const)("emits no request for a rejected method token: %s", (call) => {
  expect(requestsFor(call)).toEqual([]);
});

it.each([
  [`http.request({ host: "h", path: "/", method: "GET" })`],
  [`http.request({ host: "h", path: "/", method: "get" })`],
  [`http.request({ host: "h", path: "/", method: "M-SEARCH" })`],
  [`http.request({ host: "h", path: "/", method: "X" })`],
  // Node reads an empty method as "not given" and falls back to GET.
  [`http.request({ host: "h", path: "/", method: "" })`],
  [`http.request({ host: "h", path: "/" })`],
  // `fetch` reads a different member and validates no token.
  [`fetch("http://h/", { method: "BAD METHOD" })`],
  // A binding is not a literal, so this file leaves the answer to the runtime.
  [`const m = "BAD METHOD"; http.request({ host: "h", method: m })`],
] as const)("keeps the request for an accepted method: %s", (call) => {
  expect(requestsFor(call)).toHaveLength(1);
});

it.each([
  // An erased TypeScript assertion is the same object at runtime, so the method is still
  // validated. Measured on Node 24.22.1, this throws ERR_INVALID_HTTP_TOKEN.
  [
    `http.request(({ host: "h", method: "BAD METHOD" } as any))`,
    `http.request(({ host: "h", method: "BAD METHOD" }) as any)`,
  ],
] as const)(
  "reads the options through an erased assertion: %s",
  (_name, call) => {
    expect(
      analyzeJavaScriptSemantics(
        `import http from "node:http";\nfunction f() { ${call}; }`,
      ).requestOperations,
    ).toEqual([]);
  },
);

it("keeps the request when a leading spread shifts the options slot", () => {
  // The spread supplies the options and the callback, so the trailing object is ignored
  // and Node builds a GET request. Measured on Node 24.22.1.
  const operations = analyzeJavaScriptSemantics(
    `import http from "node:http";\nfunction f() { const a = [{ host: "h" }, () => {}]; http.request(...a, { method: "BAD METHOD" }); }`,
  ).requestOperations;
  expect(operations).toHaveLength(1);
});

it.each([
  // A callable first argument is the callback, so Node ignores a later options object.
  [`http.request(() => {}, { method: "BAD METHOD" })`],
  [`http.request(function () {}, { method: "BAD METHOD" })`],
  // A getter runs before the copy and can rewrite the method.
  [`http.request({ get x() { this.method = "GET"; }, method: "BAD METHOD" })`],
] as const)(
  "keeps the request for a callable or accessor-written options: %s",
  (call) => {
    expect(requestsFor(call)).toHaveLength(1);
  },
);

it.each([
  // A callback after the options does not move the slot; the method in slot 0 is still
  // validated. Measured on Node 24.22.1.
  [`http.request({ method: "BAD METHOD" }, () => {})`],
  // A getter after the member cannot change the value that was already copied.
  [`http.request({ method: "BAD METHOD", get x() { this.method = "GET"; } })`],
] as const)(
  "emits no request when the callback or getter follows: %s",
  (call) => {
    expect(requestsFor(call)).toEqual([]);
  },
);

it("keeps the request when the getter precedes the member", () => {
  // The getter runs before the copy reaches `method`, so it rewrites the source value.
  expect(
    requestsFor(
      `http.request({ get x() { this.method = "GET"; }, method: "BAD METHOD" })`,
    ),
  ).toHaveLength(1);
});

it("keeps the request for a valid options object with a callback", () => {
  expect(
    requestsFor(`http.request({ host: "h", port: 1, path: "/" }, () => {})`),
  ).toHaveLength(1);
});

it.each([
  // An erased assertion leaves the same function at runtime, so slot 0 is still the callback.
  [`http.request((() => {}) as any, { method: "BAD METHOD" })`],
  // `Object.assign` enumerates integer-index keys before string keys, so getter `0` runs
  // before `method` is copied even though it is written after it.
  [`http.request({ method: "BAD METHOD", get 0() { this.method = "GET"; } })`],
] as const)(
  "keeps the request for a callback or integer-key getter: %s",
  (call) => {
    expect(requestsFor(call)).toHaveLength(1);
  },
);

it("emits no request when a string-key getter follows the member", () => {
  // A string key enumerates in insertion order, so this getter runs after the copy.
  expect(
    requestsFor(
      `http.request({ method: "BAD METHOD", get x() { this.method = "GET"; } })`,
    ),
  ).toEqual([]);
});

it.each([
  // A redefined key keeps its first insertion position, so this getter enumerates first.
  [
    `http.request({ x: 0, method: "BAD METHOD", get x() { this.method = "GET"; } })`,
  ],
  // 4294967294 is an array index and enumerates first; 4294967295 is not, and does not.
  [
    `http.request({ method: "BAD METHOD", get 4294967294() { this.method = "GET"; } })`,
  ],
  // A spread before the options slot can still supply it.
  [`http.request(...[{ method: "BAD METHOD" }])`],
] as const)(
  "keeps the request for a reordered or spread-supplied options: %s",
  (call) => {
    expect(requestsFor(call)).toHaveLength(1);
  },
);

it.each([
  // A getter on a fresh key enumerates after the member, so the invalid value was copied first.
  [
    `http.request({ y: 0, method: "BAD METHOD", get x() { this.method = "GET"; } })`,
  ],
  // 4294967295 is not an array index, so it enumerates with the string keys, after `method`.
  [
    `http.request({ method: "BAD METHOD", get 4294967295() { this.method = "GET"; } })`,
  ],
  // A spread after the options cannot move the slot.
  [`http.request({ method: "BAD METHOD" }, ...[])`],
] as const)(
  "emits no request for a getter or spread after the member: %s",
  (call) => {
    expect(requestsFor(call)).toEqual([]);
  },
);
