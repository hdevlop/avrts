import { describe, expect, test } from "bun:test";
import * as A from "../src";

const bit = (n: number) => 1 << n;
type Avr = ReturnType<typeof A.AVR>;
const counts = (avr: Avr) => [
  avr.cpu.readData(A.TCNT0),
  avr.cpu.readData(A.TCNT1L) | (avr.cpu.readData(A.TCNT1H) << 8),
  avr.cpu.readData(A.TCNT2),
];

for (const timing of ["fast", "cycle-exact"] as const) {
  describe(`${timing}: wake clock-domain restart`, () => {
    for (const mode of [0, 1, 2, 3, 6, 7]) {
      for (const interrupts of [false, true]) {
        test(`sleep ${mode}, I=${Number(interrupts)} clocks timers throughout wake and interrupt entry`, () => {
          const avr = A.AVR({ timing });
          avr.cpu.writeData(A.TCCR0B, 1);
          avr.cpu.writeData(A.TCCR1B, 1);
          avr.cpu.writeData(A.TCCR2B, 1);
          avr.runCycles(5);
          avr.cpu.writeData(A.SMCR, (mode << 1) | 1);
          avr.cpu.sleep();
          avr.runCycles(11);
          const restored = A.AVR().restore(avr.snapshot());
          for (const chip of [avr, restored]) {
            const before = counts(chip);
            expect(before).toEqual(mode === 0 ? [16, 16, 16] : [5, 5, 5]);
            chip.cpu.sreg.I = interrupts;
            chip.cpu.requestInterrupt(A.INT0_VECTOR);
            const start = chip.cpu.cycles;
            chip.cpu.tick();
            const entry = interrupts ? 8 : 4;
            expect(chip.cpu.cycles - start).toBe(entry + 1);
            expect(chip.cpu.isSleeping).toBe(false);
            expect(counts(chip)).toEqual(before.map(value => value + entry + (mode === 0 ? 1 : 0)));
          }
        });
      }
    }

    for (const source of ["SPI", "USART", "ADC"] as const) {
      for (const interrupts of [false, true]) {
        for (const gated of [false, true]) {
          test(`${source} completion during wake, I=${Number(interrupts)}, PRR=${Number(gated)}`, () => {
            const avr = A.AVR({ timing });
            const duration = source === "SPI" ? 32 : source === "USART" ? 176 : 50;
            const flagAddr = source === "SPI" ? A.SPSR : source === "USART" ? A.UCSR0A : A.ADCSRA;
            const flagBit = source === "SPI" ? A.SPIF : source === "USART" ? A.TXC0 : A.ADIF;
            const powerBit = source === "SPI" ? A.PRSPI : source === "USART" ? A.PRUSART0 : A.PRADC;
            const vector = source === "SPI" ? A.SPI_STC_VECTOR : source === "USART" ? A.USART_TX_VECTOR : A.ADC_VECTOR;
            if (source === "SPI") {
              avr.cpu.writeData(A.DDRB, bit(2));
              avr.cpu.writeData(A.SPCR, bit(A.SPE) | bit(A.MSTR) | bit(A.SPIE));
              avr.cpu.writeData(A.SPDR, 0x42);
            } else if (source === "USART") {
              avr.cpu.writeData(A.UCSR0B, bit(A.TXEN0) | bit(A.TXCIE0));
              avr.cpu.writeData(A.UDR0, 0x42);
            } else {
              avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC) | bit(A.ADIE));
            }
            avr.runCycles(duration - 3);
            avr.cpu.writeData(A.SMCR, (2 << 1) | 1);
            avr.cpu.sleep();
            avr.runCycles(100);
            if (gated) avr.cpu.writeData(A.PRR, bit(powerBit));
            const restored = A.AVR().restore(avr.snapshot());
            for (const chip of [avr, restored]) {
              expect(chip.cpu.readData(flagAddr) & bit(flagBit)).toBe(0);
              chip.cpu.sreg.I = interrupts;
              chip.cpu.requestInterrupt(A.INT0_VECTOR);
              chip.cpu.tick();
              expect(chip.cpu.isSleeping).toBe(false);
              expect(chip.cpu.readData(flagAddr) & bit(flagBit)).toBe(gated ? 0 : bit(flagBit));
              expect(chip.cpu.snapshot().pendingInterrupts.includes(vector)).toBe(!gated);
              if (interrupts) expect(chip.cpu.pc).toBe(A.INT0_VECTOR);
              if (gated) {
                chip.cpu.sreg.I = false;
                chip.cpu.writeData(A.PRR, 0);
                chip.runCycles(2);
                expect(chip.cpu.readData(flagAddr) & bit(flagBit)).toBe(0);
                chip.runCycles(1);
                expect(chip.cpu.readData(flagAddr) & bit(flagBit)).toBe(bit(flagBit));
              }
            }
          });
        }
      }
    }

    test("wake without ISR advances the stopped counters' common divider", () => {
      const avr = A.AVR({ timing });
      avr.runCycles(3);
      avr.cpu.writeData(A.SMCR, (2 << 1) | 1);
      avr.cpu.sleep();
      avr.runCycles(100);
      const restored = A.AVR().restore(avr.snapshot());
      for (const chip of [avr, restored]) {
        chip.cpu.requestInterrupt(A.INT0_VECTOR);
        chip.cpu.tick(); // Four wake clocks: shared divider phase is now seven.
        chip.cpu.clearInterrupt(A.INT0_VECTOR);
        chip.cpu.writeData(A.TCCR0B, 2);
        chip.cpu.writeData(A.TCCR1B, 2);
        expect(counts(chip).slice(0, 2)).toEqual([0, 0]);
        chip.runCycles(1);
        expect(counts(chip).slice(0, 2)).toEqual([1, 1]);
      }
    });

    for (const interrupts of [false, true]) {
      for (const gated of [false, true]) {
        test(`Timer2 asynchronous wake restarts synchronous timers, I=${Number(interrupts)}, PRTIM0=${Number(gated)}`, () => {
          const avr = A.AVR({ timing, clockHz: 1_638_400 });
          avr.cpu.writeData(A.OCR2A, 2);
          avr.cpu.writeData(A.OCR2B, 250);
          avr.cpu.writeData(A.TCCR2B, 1);
          avr.cpu.writeData(A.ASSR, bit(A.AS2));
          avr.cpu.writeData(A.TIMSK2, bit(A.OCIE2A));
          avr.cpu.writeData(A.TCCR0B, 1);
          avr.cpu.writeData(A.TCCR1B, 1);
          avr.runCycles(75);
          if (gated) avr.cpu.writeData(A.PRR, bit(A.PRTIM0));
          avr.cpu.sreg.I = interrupts;
          avr.cpu.writeData(A.SMCR, (3 << 1) | 1);
          avr.cpu.sleep();
          avr.runCycles(74);
          const restored = A.AVR().restore(avr.snapshot());
          for (const chip of [avr, restored]) {
            expect(counts(chip).slice(0, 2)).toEqual([75, 75]);
            chip.runCycles(1);
            const entry = interrupts ? 8 : 4;
            expect(chip.cpu.cycles).toBe(150 + entry);
            expect(counts(chip).slice(0, 2)).toEqual([75 + (gated ? 0 : entry), 75 + entry]);
          }
        });
      }
    }
  });
}
