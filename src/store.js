import { mkdir, appendFile, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

/** Append-only JSON-lines log. Writes are serialised so lines never interleave. */
export class JsonlLog {
  constructor(file) {
    this.file = file;
    this.ready = mkdir(path.dirname(file), { recursive: true });
    this.chain = Promise.resolve();
  }
  add(record) {
    const write = this.chain.then(async () => {
      await this.ready;
      await appendFile(this.file, JSON.stringify(record) + "\n", { mode: 0o600 });
    });
    this.chain = write.catch(() => {});
    return write;
  }
  async all() {
    await this.ready;
    let raw;
    try { raw = await readFile(this.file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ }
    }
    return out;
  }
  /** Matching records, newest first. */
  async query(filter = () => true, limit = Infinity) {
    return (await this.all()).filter(filter).reverse().slice(0, limit);
  }
}

/** Small JSON document kept in memory and saved atomically (temp file + rename). */
export class JsonDoc {
  constructor(file, initial) {
    this.file = file;
    this.initial = initial;
    this.data = null;
    this.loading = null;
    this.chain = Promise.resolve();
  }
  load() {
    this.loading ||= (async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      try { this.data = JSON.parse(await readFile(this.file, "utf8")); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        this.data = structuredClone(this.initial);
      }
      return this.data;
    })();
    return this.loading;
  }
  save() {
    const snapshot = JSON.stringify(this.data, null, 2);
    const write = this.chain.then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    this.chain = write.catch(() => {});
    return write;
  }
}
