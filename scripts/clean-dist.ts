import { rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dist = resolve(root, "dist");

if (dirname(dist) !== root || basename(dist) !== "dist") {
  throw new Error(`Refusing to clean unexpected output directory: ${dist}`);
}

rmSync(dist, { recursive: true, force: true });
