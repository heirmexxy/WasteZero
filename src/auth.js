import { timingSafeEqual } from "node:crypto";

export function isAuthorized(request, expectedKey) {
  if (!expectedKey) return false;
  const header = request.headers.authorization || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(expectedKey);
  return a.length === b.length && timingSafeEqual(a, b);
}
