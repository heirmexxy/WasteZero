/**
 * In-memory answer cache, separated per customer. Holds full responses only in memory
 * and only for customers who allowed the "cache" optimisation. Nothing is written to disk.
 */
export class ResponseCache {
  constructor({ maxEntries = 5000, now = () => Date.now() } = {}) {
    this.max = maxEntries;
    this.now = now;
    this.map = new Map();
  }
  key(tenantId, fp) { return `${tenantId}:${fp}`; }
  get(tenantId, fp) {
    const k = this.key(tenantId, fp);
    const hit = this.map.get(k);
    if (!hit) return null;
    if (hit.expires <= this.now()) { this.map.delete(k); return null; }
    this.map.delete(k);   // refresh recency
    this.map.set(k, hit);
    return hit.value;
  }
  set(tenantId, fp, value, ttlSec) {
    if (this.max <= 0) return;
    const k = this.key(tenantId, fp);
    this.map.delete(k);
    this.map.set(k, { value, expires: this.now() + ttlSec * 1000 });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  clearTenant(tenantId) {
    for (const k of this.map.keys()) if (k.startsWith(tenantId + ":")) this.map.delete(k);
  }
}
