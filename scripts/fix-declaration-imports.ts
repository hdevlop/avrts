import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const typesRoot = resolve(import.meta.dir, "..", "dist", "types");

function declarationFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...declarationFiles(path));
    else if (entry.name.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

function runtimeSpecifier(file: string, specifier: string): string {
  if (/\.(?:[cm]?js|json)$/i.test(specifier)) return specifier;
  const withoutTs = specifier.replace(/\.(?:[cm]?ts)$/i, "");
  const target = resolve(dirname(file), withoutTs);
  if (existsSync(`${target}.d.ts`)) return `${withoutTs}.js`;
  if (existsSync(join(target, "index.d.ts"))) return `${withoutTs}/index.js`;
  throw new Error(`Cannot resolve declaration import ${specifier} from ${file}`);
}

for (const file of declarationFiles(typesRoot)) {
  const source = readFileSync(file, "utf8");
  const fixed = source.replace(/(["'])(\.{1,2}\/[^"']+)\1/g, (match, quote: string, specifier: string) => {
    return `${quote}${runtimeSpecifier(file, specifier)}${quote}`;
  });
  if (fixed !== source) writeFileSync(file, fixed);
}
