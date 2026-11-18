import { JsonDoc } from "./store.js";

/**
 * Business settings the founder changes from the admin console (no server restart).
 *
 * Teams seat price: a fee per employee who used AI through WasteZero in a month.
 * Each change is kept with the month it takes effect, so an invoice always uses the price
 * that applied in its own month, and a change never lands on customers mid-month unannounced.
 */

export const DEFAULT_TEAMS_SEAT_USD = 5;
const monthOf = (d) => d.toISOString().slice(0, 7);
const nextMonth = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);

export class Settings {
  constructor(file, config) {
    this.doc = new JsonDoc(file, { teamsSeatPrices: [] });
    this.config = config;
    this.base = config.billing.teamsSeatUsd;   // from TEAMS_SEAT_PRICE_USD, or the default
  }
  async init() {
    await this.doc.load();
    this.doc.data.teamsSeatPrices ||= [];
    // Everything that reads config.billing (public pages, invoices) sees the price in force today.
    const self = this;
    Object.defineProperty(this.config.billing, "teamsSeatUsd", { get: () => self.seatPriceFor(monthOf(new Date())), enumerable: true, configurable: true });
    Object.defineProperty(this.config.billing, "teamsSeatUpcoming", { get: () => self.upcomingSeatPrice(), enumerable: false, configurable: true });
  }
  get prices() { return this.doc.data.teamsSeatPrices; }

  /** The seat price that applies to invoices for `period` (YYYY-MM). */
  seatPriceFor(period) {
    const applicable = this.prices.filter((e) => e.effectiveFrom <= period)
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.setAt.localeCompare(b.setAt));
    return applicable.length ? applicable.at(-1).usd : this.base;
  }
  upcomingSeatPrice(now = new Date()) {
    const cur = monthOf(now);
    const later = this.prices.filter((e) => e.effectiveFrom > cur).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.setAt.localeCompare(b.setAt));
    return later.length ? { usd: later.at(-1).usd, effectiveFrom: later.at(-1).effectiveFrom } : null;
  }

  /** when: "next_month" (default: announced, fair to customers) or "now" (this month's invoices too). */
  async setSeatPrice(usd, { when = "next_month", by = "admin", now = new Date() } = {}) {
    const v = Math.round(Number(usd) * 100) / 100;
    if (!Number.isFinite(v) || v < 0 || v > 1000) throw new Error("The seat price must be between $0 and $1,000");
    if (!["next_month", "now"].includes(when)) throw new Error("when is next_month or now");
    const effectiveFrom = when === "now" ? monthOf(now) : nextMonth(now);
    const from = this.seatPriceFor(effectiveFrom);
    // A newer decision for the same month replaces any earlier one still pending for it.
    this.doc.data.teamsSeatPrices = this.prices.filter((e) => !(e.effectiveFrom === effectiveFrom && e.effectiveFrom > monthOf(now)));
    const entry = { usd: v, effectiveFrom, setAt: now.toISOString(), by, from };
    this.prices.push(entry);
    if (this.prices.length > 200) this.doc.data.teamsSeatPrices = this.prices.slice(-200);
    await this.doc.save();
    return entry;
  }

  view(now = new Date()) {
    return {
      teamsSeat: {
        currentUsd: this.seatPriceFor(monthOf(now)), currentMonth: monthOf(now), upcoming: this.upcomingSeatPrice(now),
        defaultUsd: this.base, history: this.prices.slice(-20).reverse()
      }
    };
  }
}

/** Billing settings for one invoice period: the seat price that applied in that month. */
export function billingFor(ctx, period) {
  const b = ctx.config.billing;
  return { billUsage: b.billUsage, usageMarkupPct: b.usageMarkupPct, teamsSeatUsd: ctx.settings ? ctx.settings.seatPriceFor(period) : b.teamsSeatUsd };
}
