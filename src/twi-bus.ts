import type { AVR } from "./avr";

/** Logical pulled-up, wired-AND SDA/SCL bus. The host advances connected AVR clocks. */
export function createTwiBus() {
  const endpoints = new Map<AVR, () => void>();
  let resolving = false;
  let dirty = false;
  const synchronize = () => {
    dirty = true;
    if (resolving) return;
    resolving = true;
    try {
      while (dirty) {
        dirty = false;
        const drives = [...endpoints.keys()].map((avr) => ({ avr, ...avr.twi.readDrive() }));
        for (const endpoint of drives) {
          // Each AVR's own open-drain driver is already resolved in GPIO.
          endpoint.avr.pin(18).setInput(drives.every((other) => other.avr === endpoint.avr || other.sdaReleased));
          endpoint.avr.pin(19).setInput(drives.every((other) => other.avr === endpoint.avr || other.sclReleased));
        }
      }
    } finally { resolving = false; }
  };
  return {
    /** Enable wire mode and attach an AVR; unsubscribe disconnects it and releases the bus. */
    connect(avr: AVR): () => void {
      if (endpoints.has(avr)) throw new Error("AVR is already connected to this TWI bus.");
      avr.twi.useWire();
      const offDrive = avr.twi.onDrive(synchronize);
      const offRestore = avr.on("restore", synchronize);
      const off = () => { offDrive(); offRestore(); };
      endpoints.set(avr, off); synchronize();
      return () => {
        if (!endpoints.delete(avr)) return;
        off(); avr.pin(18).setInput(true); avr.pin(19).setInput(true); synchronize();
      };
    },
    synchronize,
  };
}
