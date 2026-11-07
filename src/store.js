import { mkdir, appendFile, readFile } from "node:fs/promises";
import path from "node:path";

export class EventStore {
  constructor(directory) {
    this.file = path.join(directory, "events.jsonl");
    this.ready = mkdir(directory, { recursive: true });
  }
  async add(event) {
    await this.ready;
    await appendFile(this.file, JSON.stringify(event) + "\n", { mode: 0o600 });
  }
  async list(limit = 1000) {
    await this.ready;
    let raw;
    try { raw = await readFile(this.file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    return raw.split("\n").filter(Boolean).slice(-limit).reverse().flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }
}
