import { createHmac, timingSafeEqual } from "node:crypto";
import { sha256 } from "./util.js";

// Signed, expiring links (card setup, unsubscribe) so no API key ever appears in a URL.
const secret = (config) => config.signingSecret || sha256("wastezero-links:" + config.adminKey);

export function signToken(config, payload, ttlSec = 7 * 86400) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString("base64url");
  const mac = createHmac("sha256", secret(config)).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyToken(config, token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expected = createHmac("sha256", secret(config)).update(body).digest("base64url");
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return payload.exp > Date.now() / 1000 ? payload : null;
  } catch { return null; }
}

export const link = (config, pathname, params) =>
  `${config.publicBaseUrl}${pathname}?${new URLSearchParams(params).toString()}`;
