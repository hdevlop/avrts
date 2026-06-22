import { ioReadRegistry, ioRegistry } from "../core";
import type { CPU, IoReadHook, IoWriteHook } from "../cpu";
import type { IoHookEntry } from "../core";

/**
 * Install a peripheral's @OnWrite / @OnRead hooks into the CPU. Only entries whose
 * prototype matches this peripheral are attached, so the shared global registries
 * can hold hooks from many peripheral classes without cross-wiring.
 */
export function attachPeripheral(cpu: CPU, peripheral: object): void {
  const proto = Object.getPrototypeOf(peripheral) as object;
  for (const entry of matchingEntries(ioRegistry, peripheral, proto)) {
    cpu.installWriteHook(entry.addr, (entry.method as IoWriteHook).bind(peripheral));
  }
  for (const entry of matchingEntries(ioReadRegistry, peripheral, proto)) {
    cpu.installReadHook(entry.addr, (entry.method as IoReadHook).bind(peripheral));
  }
}

/** Resolve the registry entries whose method belongs to this peripheral instance. */
function matchingEntries(
  registry: IoHookEntry[],
  peripheral: object,
  proto: object,
): Array<{ addr: number; method: (...args: never[]) => unknown }> {
  const resolved: Array<{ addr: number; method: (...args: never[]) => unknown }> = [];
  for (const entry of registry) {
    if (entry.proto !== undefined && entry.proto !== proto) continue;
    const method = (peripheral as unknown as Record<string, unknown>)[entry.key];
    if (typeof method !== "function") {
      if (entry.proto !== undefined) {
        throw new Error(`I/O hook handler "${entry.key}" is not a method`);
      }
      continue;
    }
    resolved.push({ addr: entry.addr, method: method as (...args: never[]) => unknown });
  }
  return resolved;
}
