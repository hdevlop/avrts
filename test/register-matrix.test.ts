import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AVR } from "../src";
import * as cpuConstants from "../src/cpu";

/**
 * Phase 0 of docs/complete-atmega328p-plan.md: the register & vector coverage
 * matrix. Every ATmega328P IO/extended-IO address (0x20-0xff) and all 26
 * interrupt vectors are classified here, and the classification is checked
 * against the live simulator (installed hooks) and docs/limitations.md so the
 * completeness claim can never silently rot in either direction.
 */

type RegisterStatus = "modeled" | "storage" | "unmodeled" | "reserved";

interface RegisterRow {
  addr: number;
  name: string;
  status: RegisterStatus;
}

function reserved(from: number, to: number): RegisterRow[] {
  const rows: RegisterRow[] = [];
  for (let addr = from; addr <= to; addr += 1) rows.push({ addr, name: "-", status: "reserved" });
  return rows;
}

function row(addr: number, name: string, status: Exclude<RegisterStatus, "reserved">): RegisterRow {
  return { addr, name, status };
}

// Datasheet register summary (ATmega328P, sections 36 "Register summary").
const REGISTER_MATRIX: RegisterRow[] = [
  ...reserved(0x20, 0x22),
  row(0x23, "PINB", "modeled"),
  row(0x24, "DDRB", "modeled"),
  row(0x25, "PORTB", "modeled"),
  row(0x26, "PINC", "modeled"),
  row(0x27, "DDRC", "modeled"),
  row(0x28, "PORTC", "modeled"),
  row(0x29, "PIND", "modeled"),
  row(0x2a, "DDRD", "modeled"),
  row(0x2b, "PORTD", "modeled"),
  ...reserved(0x2c, 0x34),
  row(0x35, "TIFR0", "modeled"),
  row(0x36, "TIFR1", "modeled"),
  row(0x37, "TIFR2", "modeled"),
  ...reserved(0x38, 0x3a),
  row(0x3b, "PCIFR", "modeled"),
  row(0x3c, "EIFR", "modeled"),
  row(0x3d, "EIMSK", "modeled"),
  row(0x3e, "GPIOR0", "storage"),
  row(0x3f, "EECR", "modeled"),
  row(0x40, "EEDR", "modeled"),
  row(0x41, "EEARL", "modeled"),
  row(0x42, "EEARH", "modeled"),
  row(0x43, "GTCCR", "modeled"),
  row(0x44, "TCCR0A", "modeled"),
  row(0x45, "TCCR0B", "modeled"),
  row(0x46, "TCNT0", "modeled"),
  row(0x47, "OCR0A", "modeled"),
  row(0x48, "OCR0B", "modeled"),
  ...reserved(0x49, 0x49),
  row(0x4a, "GPIOR1", "storage"),
  row(0x4b, "GPIOR2", "storage"),
  row(0x4c, "SPCR", "modeled"),
  row(0x4d, "SPSR", "modeled"),
  row(0x4e, "SPDR", "modeled"),
  ...reserved(0x4f, 0x4f),
  row(0x50, "ACSR", "modeled"),
  ...reserved(0x51, 0x52),
  row(0x53, "SMCR", "modeled"),
  row(0x54, "MCUSR", "modeled"),
  row(0x55, "MCUCR", "modeled"),
  ...reserved(0x56, 0x56),
  row(0x57, "SPMCSR", "modeled"),
  ...reserved(0x58, 0x5c),
  row(0x5d, "SPL", "modeled"),
  row(0x5e, "SPH", "modeled"),
  row(0x5f, "SREG", "modeled"),
  row(0x60, "WDTCSR", "modeled"),
  row(0x61, "CLKPR", "modeled"),
  ...reserved(0x62, 0x63),
  row(0x64, "PRR", "modeled"),
  ...reserved(0x65, 0x65),
  row(0x66, "OSCCAL", "storage"),
  ...reserved(0x67, 0x67),
  row(0x68, "PCICR", "modeled"),
  row(0x69, "EICRA", "modeled"),
  ...reserved(0x6a, 0x6a),
  row(0x6b, "PCMSK0", "modeled"),
  row(0x6c, "PCMSK1", "modeled"),
  row(0x6d, "PCMSK2", "modeled"),
  row(0x6e, "TIMSK0", "modeled"),
  row(0x6f, "TIMSK1", "modeled"),
  row(0x70, "TIMSK2", "modeled"),
  ...reserved(0x71, 0x77),
  row(0x78, "ADCL", "modeled"),
  row(0x79, "ADCH", "modeled"),
  row(0x7a, "ADCSRA", "modeled"),
  row(0x7b, "ADCSRB", "modeled"),
  row(0x7c, "ADMUX", "modeled"),
  ...reserved(0x7d, 0x7d),
  row(0x7e, "DIDR0", "storage"),
  row(0x7f, "DIDR1", "storage"),
  row(0x80, "TCCR1A", "modeled"),
  row(0x81, "TCCR1B", "modeled"),
  row(0x82, "TCCR1C", "modeled"),
  ...reserved(0x83, 0x83),
  row(0x84, "TCNT1L", "modeled"),
  row(0x85, "TCNT1H", "modeled"),
  row(0x86, "ICR1L", "modeled"),
  row(0x87, "ICR1H", "modeled"),
  row(0x88, "OCR1AL", "modeled"),
  row(0x89, "OCR1AH", "modeled"),
  row(0x8a, "OCR1BL", "modeled"),
  row(0x8b, "OCR1BH", "modeled"),
  ...reserved(0x8c, 0xaf),
  row(0xb0, "TCCR2A", "modeled"),
  row(0xb1, "TCCR2B", "modeled"),
  row(0xb2, "TCNT2", "modeled"),
  row(0xb3, "OCR2A", "modeled"),
  row(0xb4, "OCR2B", "modeled"),
  ...reserved(0xb5, 0xb5),
  row(0xb6, "ASSR", "modeled"),
  ...reserved(0xb7, 0xb7),
  row(0xb8, "TWBR", "modeled"),
  row(0xb9, "TWSR", "modeled"),
  row(0xba, "TWAR", "modeled"),
  row(0xbb, "TWDR", "modeled"),
  row(0xbc, "TWCR", "modeled"),
  row(0xbd, "TWAMR", "modeled"),
  ...reserved(0xbe, 0xbf),
  row(0xc0, "UCSR0A", "modeled"),
  row(0xc1, "UCSR0B", "modeled"),
  row(0xc2, "UCSR0C", "modeled"),
  ...reserved(0xc3, 0xc3),
  row(0xc4, "UBRR0L", "modeled"),
  row(0xc5, "UBRR0H", "modeled"),
  row(0xc6, "UDR0", "modeled"),
  ...reserved(0xc7, 0xff),
];

interface VectorRow {
  n: number;
  name: string;
  modeled: boolean;
}

// Datasheet interrupt vector table (ATmega328P, section 16.1).
const VECTOR_MATRIX: VectorRow[] = [
  { n: 1, name: "RESET", modeled: true },
  { n: 2, name: "INT0", modeled: true },
  { n: 3, name: "INT1", modeled: true },
  { n: 4, name: "PCINT0", modeled: true },
  { n: 5, name: "PCINT1", modeled: true },
  { n: 6, name: "PCINT2", modeled: true },
  { n: 7, name: "WDT", modeled: true },
  { n: 8, name: "TIMER2_COMPA", modeled: true },
  { n: 9, name: "TIMER2_COMPB", modeled: true },
  { n: 10, name: "TIMER2_OVF", modeled: true },
  { n: 11, name: "TIMER1_CAPT", modeled: true },
  { n: 12, name: "TIMER1_COMPA", modeled: true },
  { n: 13, name: "TIMER1_COMPB", modeled: true },
  { n: 14, name: "TIMER1_OVF", modeled: true },
  { n: 15, name: "TIMER0_COMPA", modeled: true },
  { n: 16, name: "TIMER0_COMPB", modeled: true },
  { n: 17, name: "TIMER0_OVF", modeled: true },
  { n: 18, name: "SPI_STC", modeled: true },
  { n: 19, name: "USART_RX", modeled: true },
  { n: 20, name: "USART_UDRE", modeled: true },
  { n: 21, name: "USART_TX", modeled: true },
  { n: 22, name: "ADC", modeled: true },
  { n: 23, name: "EE_READY", modeled: true },
  { n: 24, name: "ANALOG_COMP", modeled: true },
  { n: 25, name: "TWI", modeled: true },
  { n: 26, name: "SPM_READY", modeled: true },
];

const LIMITATIONS_MD = readFileSync(join(import.meta.dir, "..", "docs", "limitations.md"), "utf8");

/** Backticked names from one markdown table section (heading to next `## `). */
function limitationNames(heading: string): Set<string> {
  const start = LIMITATIONS_MD.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = LIMITATIONS_MD.slice(start + heading.length);
  const end = rest.indexOf("\n## ");
  const section = end === -1 ? rest : rest.slice(0, end);
  const names = new Set<string>();
  for (const match of section.matchAll(/\|\s*`([A-Z0-9_]+)`/g)) names.add(match[1]!);
  return names;
}

describe("ATmega328P register & vector coverage matrix (Phase 0)", () => {
  test("matrix covers every IO address 0x20-0xff exactly once with unique names", () => {
    const byAddr = new Map<number, RegisterRow>();
    const names = new Set<string>();
    for (const entry of REGISTER_MATRIX) {
      expect(byAddr.has(entry.addr)).toBe(false);
      byAddr.set(entry.addr, entry);
      if (entry.status !== "reserved") {
        expect(names.has(entry.name)).toBe(false);
        names.add(entry.name);
      }
    }
    for (let addr = 0x20; addr <= 0xff; addr += 1) {
      expect(byAddr.has(addr)).toBe(true);
    }
    expect(REGISTER_MATRIX.length).toBe(0x100 - 0x20);
  });

  test("every register with an installed hook is classified modeled", () => {
    const avr = AVR();
    for (const entry of REGISTER_MATRIX) {
      const hooked =
        avr.cpu.writeHooks[entry.addr] !== undefined || avr.cpu.readHooks[entry.addr] !== undefined;
      if (hooked) {
        expect(`${entry.name}:${entry.status}`).toBe(`${entry.name}:modeled`);
      }
    }
  });

  test("reserved, storage, and unmodeled registers have no hooks", () => {
    const avr = AVR();
    for (const entry of REGISTER_MATRIX) {
      if (entry.status === "modeled") continue;
      const label = `0x${entry.addr.toString(16)} ${entry.name}`;
      expect(`${label} hooked=${avr.cpu.writeHooks[entry.addr] !== undefined}`).toBe(`${label} hooked=false`);
      expect(`${label} hooked=${avr.cpu.readHooks[entry.addr] !== undefined}`).toBe(`${label} hooked=false`);
    }
  });

  test("storage registers behave as plain read/write storage", () => {
    const avr = AVR();
    for (const entry of REGISTER_MATRIX) {
      if (entry.status !== "storage") continue;
      for (const value of [0x5a, 0x00, 0xff]) {
        avr.cpu.writeData(entry.addr, value);
        expect(avr.cpu.readData(entry.addr)).toBe(value);
      }
    }
  });

  test("unmodeled registers exactly match docs/limitations.md", () => {
    const documented = limitationNames("## Unmodeled registers");
    const unmodeled = new Set(
      REGISTER_MATRIX.filter((entry) => entry.status === "unmodeled").map((entry) => entry.name),
    );
    expect([...documented].sort()).toEqual([...unmodeled].sort());
  });

  test("vector table is complete and constants match datasheet addresses", () => {
    expect(VECTOR_MATRIX.length).toBe(26);
    VECTOR_MATRIX.forEach((vector, index) => {
      expect(vector.n).toBe(index + 1);
      const constant = (cpuConstants as Record<string, unknown>)[`${vector.name}_VECTOR`];
      if (vector.modeled) {
        expect(`${vector.name}=${String(constant)}`).toBe(`${vector.name}=${(vector.n - 1) * 2}`);
      } else if (constant !== undefined) {
        // A constant may pre-exist an unmodeled vector, but it must be correct.
        expect(constant).toBe((vector.n - 1) * 2);
      }
    });
  });

  test("unmodeled vectors exactly match docs/limitations.md", () => {
    const documented = limitationNames("## Unmodeled interrupt vectors");
    const unmodeled = new Set(
      VECTOR_MATRIX.filter((vector) => !vector.modeled).map((vector) => vector.name),
    );
    expect([...documented].sort()).toEqual([...unmodeled].sort());
  });
});
