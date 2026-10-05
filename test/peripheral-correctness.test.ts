import { describe, expect, test } from "bun:test";
import * as A from "../src";

// Register-level regressions based on the ATmega328P datasheet.
type Avr = ReturnType<typeof A.AVR>;
const bit = (n: number) => 1 << n;
type Source = {
  name: string; vector: number;
  prepare(avr: Avr, enabled: boolean): void;
  clearFlag(avr: Avr): void;
  setEnabled(avr: Avr, enabled: boolean): void;
};
const sources: Source[] = [
  {
    name: "ADC", vector: A.ADC_VECTOR,
    prepare(avr, enabled) {
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC) | (enabled ? bit(A.ADIE) : 0));
      avr.runCycles(60);
    },
    clearFlag(avr) { avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADIE) | bit(A.ADIF)); },
    setEnabled(avr, enabled) { avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | (enabled ? bit(A.ADIE) : 0)); },
  },
  {
    name: "analog comparator", vector: A.ANALOG_COMP_VECTOR,
    prepare(avr, enabled) {
      avr.comparator.setInput("ain1", 1);
      avr.cpu.writeData(A.ACSR, bit(A.ACIS0) | bit(A.ACIS1) | (enabled ? bit(A.ACIE) : 0));
      avr.comparator.setInput("ain0", 2);
    },
    clearFlag(avr) { avr.cpu.writeData(A.ACSR, bit(A.ACIS0) | bit(A.ACIS1) | bit(A.ACIE) | bit(A.ACI)); },
    setEnabled(avr, enabled) { avr.cpu.writeData(A.ACSR, bit(A.ACIS0) | bit(A.ACIS1) | (enabled ? bit(A.ACIE) : 0)); },
  },
  {
    name: "SPI", vector: A.SPI_STC_VECTOR,
    prepare(avr, enabled) {
      avr.cpu.writeData(A.DDRB, bit(2));
      avr.cpu.writeData(A.SPCR, bit(A.SPE) | bit(A.MSTR) | (enabled ? bit(A.SPIE) : 0));
      avr.cpu.writeData(A.SPDR, 0x55);
      avr.runCycles(32);
    },
    clearFlag(avr) { avr.cpu.readData(A.SPSR); avr.cpu.readData(A.SPDR); },
    setEnabled(avr, enabled) { avr.cpu.writeData(A.SPCR, bit(A.SPE) | bit(A.MSTR) | (enabled ? bit(A.SPIE) : 0)); },
  },
  {
    name: "TWI", vector: A.TWI_VECTOR,
    prepare(avr, enabled) {
      avr.cpu.writeData(A.TWCR, bit(A.TWEN) | bit(A.TWSTA) | bit(A.TWINT) | (enabled ? bit(A.TWIE) : 0));
      avr.runCycles(1);
    },
    clearFlag(avr) { avr.cpu.writeData(A.TWCR, bit(A.TWEN) | bit(A.TWIE) | bit(A.TWINT)); },
    setEnabled(avr, enabled) { avr.cpu.writeData(A.TWCR, bit(A.TWEN) | (enabled ? bit(A.TWIE) : 0)); },
  },
  {
    name: "pin change", vector: A.PCINT0_VECTOR,
    prepare(avr, enabled) {
      avr.cpu.writeData(A.PCMSK0, bit(0));
      avr.cpu.writeData(A.PCICR, enabled ? bit(0) : 0);
      avr.pin(8).setInput(true);
    },
    clearFlag(avr) { avr.cpu.writeData(A.PCIFR, bit(0)); },
    setEnabled(avr, enabled) { avr.cpu.writeData(A.PCICR, enabled ? bit(0) : 0); },
  },
  {
    name: "INT0", vector: A.INT0_VECTOR,
    prepare(avr, enabled) {
      avr.cpu.writeData(A.EICRA, 3);
      avr.cpu.writeData(A.EIMSK, enabled ? bit(0) : 0);
      avr.pin(2).setInput(true);
    },
    clearFlag(avr) { avr.cpu.writeData(A.EIFR, bit(0)); },
    setEnabled(avr, enabled) { avr.cpu.writeData(A.EIMSK, enabled ? bit(0) : 0); },
  },
];

for (const timing of ["fast", "cycle-exact"] as const) {
  describe(`${timing}: interrupt requests must track live flags and enables`, () => {
    for (const source of sources) {
      test(`${source.name}: control - a live request dispatches`, () => {
        const avr = A.AVR({ timing });
        source.prepare(avr, true);
        expect(avr.snapshot().cpu.pendingInterrupts).toContain(source.vector);
        avr.cpu.sreg.I = true;
        avr.step();
        expect(avr.cpu.pc).toBe(source.vector);
      });
      for (const restored of [false, true]) {
        for (const cleared of ["flag", "mask"] as const) {
          test(`${source.name}: clearing ${cleared} cancels a ${restored ? "restored" : "direct"} request`, () => {
            const original = A.AVR({ timing });
            source.prepare(original, true);
            const avr = restored ? A.AVR().restore(original.snapshot()) : original;
            expect(avr.snapshot().cpu.pendingInterrupts).toContain(source.vector);
            if (cleared === "flag") source.clearFlag(avr);
            else source.setEnabled(avr, false);
            const expectedPc = avr.cpu.pc + 1;
            avr.cpu.sreg.I = true;
            avr.step();
            expect(avr.cpu.pc).toBe(expectedPc);
          });
        }
      }
      test(`${source.name}: enabling a source with a latched flag dispatches`, () => {
        const avr = A.AVR({ timing });
        source.prepare(avr, false);
        expect(avr.snapshot().cpu.pendingInterrupts).not.toContain(source.vector);
        source.setEnabled(avr, true);
        avr.cpu.sreg.I = true;
        avr.step();
        expect(avr.cpu.pc).toBe(source.vector);
      });
    }
  });

  describe(`${timing}: ADC conversion state`, () => {
    test("the first conversion takes 25 ADC clocks instead of 13", () => {
      const avr = A.AVR({ timing });
      avr.analog(0).setValue(456);
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC)); // /2 ADC clock
      avr.runCycles(30); // Before the first conversion's 50-cycle minimum.
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADSC)).toBe(bit(A.ADSC));
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADIF)).toBe(0);
      avr.runCycles(19);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADSC)).toBe(bit(A.ADSC));
      avr.runCycles(1);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADSC)).toBe(0);
      expect(avr.cpu.readData(A.ADCL) | (avr.cpu.readData(A.ADCH) << 8)).toBe(456);

      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC) | bit(A.ADIF));
      avr.runCycles(25);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADSC)).toBe(bit(A.ADSC));
      avr.runCycles(1);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADSC)).toBe(0);

      avr.cpu.writeData(A.ADCSRA, 0);
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC) | bit(A.ADIF));
      avr.runCycles(49);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADSC)).toBe(bit(A.ADSC));
      avr.runCycles(1);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADSC)).toBe(0);
    });
    function warmedAdc(value = 0): Avr {
      const avr = A.AVR({ timing });
      avr.analog(0).setValue(value);
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC));
      avr.runCycles(60); // Exclude first-conversion timing from these cases.
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADIF));
      return avr;
    }
    function result(avr: Avr): number {
      return avr.cpu.readData(A.ADCL) | (avr.cpu.readData(A.ADCH) << 8);
    }
    test("control - ordinary conversion completes with the selected value", () => {
      const avr = warmedAdc();
      avr.analog(0).setValue(123);
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC));
      avr.runCycles(60);
      expect(result(avr)).toBe(123);
    });
    test("clearing ADEN aborts the conversion without updating the result or ADIF", () => {
      const avr = warmedAdc(17);
      avr.analog(0).setValue(999);
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC));
      avr.runCycles(5);
      avr.cpu.writeData(A.ADCSRA, 0);
      avr.runCycles(60);
      expect(result(avr)).toBe(17);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADIF)).toBe(0);
    });
    test("writing ADSC=0 during a conversion cannot clear the busy bit", () => {
      const avr = warmedAdc();
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC));
      avr.runCycles(5);
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN));
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADSC)).toBe(bit(A.ADSC));
      avr.runCycles(20);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADSC)).toBe(bit(A.ADSC));
      avr.runCycles(1);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADSC)).toBe(0);
    });
    test("repeated ADSC=1 writes cannot postpone an active conversion indefinitely", () => {
      const avr = warmedAdc();
      avr.analog(0).setValue(321);
      const start = bit(A.ADEN) | bit(A.ADSC);
      avr.cpu.writeData(A.ADCSRA, start);
      for (let i = 0; i < 20; i++) {
        avr.runCycles(5);
        if ((avr.cpu.readData(A.ADCSRA) & bit(A.ADIF)) !== 0) break;
        avr.cpu.writeData(A.ADCSRA, start);
      }
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADIF)).toBe(bit(A.ADIF));
      expect(result(avr)).toBe(321);
    });
    test("reading ADCL locks both result bytes until ADCH is read", () => {
      const avr = warmedAdc(0x055);
      const low = avr.cpu.readData(A.ADCL);
      avr.analog(0).setValue(0x3aa);
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC));
      avr.runCycles(60);
      const high = avr.cpu.readData(A.ADCH);
      expect(low | (high << 8)).toBe(0x055);
      expect(result(avr)).toBe(0x055);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADIF)).toBe(bit(A.ADIF));
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC) | bit(A.ADIF));
      avr.runCycles(26);
      expect(result(avr)).toBe(0x3aa);
    });
    test("ADMUX changes during conversion affect the next conversion", () => {
      const avr = warmedAdc();
      avr.analog(0).setValue(123);
      avr.analog(1).setValue(789);
      avr.cpu.writeData(A.ADMUX, 0);
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC));
      avr.runCycles(10);
      avr.cpu.writeData(A.ADMUX, 1);
      avr.runCycles(60);
      expect(result(avr)).toBe(123);
    });
    test("an in-flight channel/reference selection survives snapshot restore", () => {
      const source = warmedAdc();
      source.analog(0).setVoltage(1.1);
      source.analog(1).setVoltage(0.55);
      source.cpu.writeData(A.ADMUX, bit(A.REFS0)); // ADC0, AVCC = 5 V
      source.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC));
      source.runCycles(10);
      source.cpu.writeData(A.ADMUX, bit(A.REFS1) | bit(A.REFS0) | 1); // ADC1, 1.1 V
      const avr = A.AVR().restore(source.snapshot());
      avr.runCycles(15);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADSC)).toBe(bit(A.ADSC));
      avr.runCycles(1);
      expect(result(avr)).toBe(225); // Still ADC0 / AVCC
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC) | bit(A.ADIF));
      avr.runCycles(26);
      expect(result(avr)).toBe(512); // The new ADC1 / 1.1 V selection
    });
    test("the result read lock survives snapshot restore", () => {
      const source = warmedAdc(0x055);
      const low = source.cpu.readData(A.ADCL);
      source.analog(0).setValue(0x3aa);
      source.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC));
      source.runCycles(5);
      const avr = A.AVR().restore(source.snapshot());
      avr.runCycles(21);
      expect(low | (avr.cpu.readData(A.ADCH) << 8)).toBe(0x055);
      expect(result(avr)).toBe(0x055);
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC) | bit(A.ADIF));
      avr.runCycles(26);
      expect(result(avr)).toBe(0x3aa);
    });
    test("restoring an enabled but unused ADC retains first-conversion timing", () => {
      const source = A.AVR({ timing });
      source.cpu.writeData(A.ADCSRA, bit(A.ADEN));
      const avr = A.AVR().restore(source.snapshot());
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC));
      avr.runCycles(49);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADSC)).toBe(bit(A.ADSC));
      avr.runCycles(1);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADSC)).toBe(0);
    });
    test("changing ADCSRB during conversion preserves its completion boundary", () => {
      const avr = warmedAdc(17);
      avr.analog(0).setValue(123);
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC));
      avr.runCycles(5);
      avr.cpu.writeData(A.ADCSRB, bit(A.ADTS0));
      avr.runCycles(20);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADSC)).toBe(bit(A.ADSC));
      avr.runCycles(1);
      expect(result(avr)).toBe(123);
    });
    test("legacy ADC snapshots without the new latch fields still restore", () => {
      const source = warmedAdc();
      source.analog(0).setValue(123);
      source.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC));
      source.runCycles(10);
      const snapshot = source.snapshot();
      delete snapshot.adc.firstConversion;
      delete snapshot.adc.conversionMux;
      delete snapshot.adc.resultLocked;
      delete snapshot.adc.sampleRemainingCycles;
      delete snapshot.adc.sampledResult;
      const avr = A.AVR().restore(snapshot);
      avr.runCycles(16);
      expect(result(avr)).toBe(123);
    });
    test("a power-reduced conversion preserves its remaining time across writes and restore", () => {
      const source = warmedAdc();
      source.analog(0).setValue(123);
      const start = bit(A.ADEN) | bit(A.ADSC);
      source.cpu.writeData(A.ADCSRA, start);
      source.runCycles(5);
      source.cpu.writeData(A.PRR, bit(A.PRADC));
      source.runCycles(100);
      source.cpu.writeData(A.ADCSRA, start);
      const avr = A.AVR().restore(source.snapshot());
      avr.runCycles(100);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADSC)).toBe(bit(A.ADSC));
      expect(result(avr)).toBe(0);
      avr.cpu.writeData(A.PRR, 0);
      avr.runCycles(20);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADSC)).toBe(bit(A.ADSC));
      avr.runCycles(1);
      expect(result(avr)).toBe(123);
    });
  });

  test(`${timing}: TWI TWINT remains set when writing zero to it`, () => {
    const avr = A.AVR({ timing });
    const twi = sources.find((source) => source.name === "TWI")!;
    twi.prepare(avr, false);
    expect(avr.cpu.readData(A.TWCR) & bit(A.TWINT)).toBe(bit(A.TWINT));
    avr.cpu.writeData(A.TWCR, bit(A.TWEN) | bit(A.TWIE));
    expect(avr.cpu.readData(A.TWCR) & bit(A.TWINT)).toBe(bit(A.TWINT));
  });

  test(`${timing}: INT0 edge latches EIFR while EIMSK is disabled`, () => {
    const avr = A.AVR({ timing });
    avr.cpu.writeData(A.EICRA, 3);
    avr.pin(2).setInput(true);
    expect(avr.cpu.readData(A.EIFR) & bit(A.INTF0)).toBe(bit(A.INTF0));
  });

  for (const [pin, enableBit, vector] of [[2, A.INT0, A.INT0_VECTOR], [3, A.INT1, A.INT1_VECTOR]] as const) {
    test(`${timing}: INT${enableBit} low-level request is withdrawn when the pin rises`, () => {
      const avr = A.AVR({ timing });
      avr.cpu.writeData(A.EIMSK, bit(enableBit));
      avr.runCycles(1);
      expect(avr.snapshot().cpu.pendingInterrupts).toContain(vector);
      avr.pin(pin).setInput(true);
      const pc = avr.cpu.pc;
      avr.cpu.sreg.I = true;
      avr.step();
      expect(avr.cpu.pc).toBe(pc + 1);
    });
  }
}

for (const timing of ["fast", "cycle-exact"] as const) {
  describe(`${timing}: remaining peripheral regressions`, () => {
    const result = (avr: Avr) => avr.cpu.readData(A.ADCL) | (avr.cpu.readData(A.ADCH) << 8);
    const warm = (avr: Avr) => {
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC));
      avr.runCycles(50);
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADIF));
    };

    test("comparator mux ignores MUX3 and accepts ADC selections 8..15", () => {
      const avr = A.AVR({ timing });
      avr.comparator.setInput("ain0", 1);
      for (let channel = 0; channel < 8; channel++) avr.analog(channel).setVoltage(2);
      avr.cpu.writeData(A.ADCSRB, bit(A.ACME));
      for (let mux = 8; mux < 16; mux++) {
        expect(() => avr.cpu.writeData(A.ADMUX, mux)).not.toThrow();
        expect(avr.comparator.readOutput()).toBe(false);
      }
    });

    for (const restored of [false, true]) {
      test(`SPI acknowledgement preserves WCOL without reading SPSR (${restored ? "restored" : "direct"})`, () => {
        const source = A.AVR({ timing });
        source.cpu.writeData(A.DDRB, bit(2));
        source.cpu.writeData(A.SPCR, bit(A.SPE) | bit(A.MSTR) | bit(A.SPIE));
        source.cpu.writeData(A.SPDR, 0x55);
        source.cpu.writeData(A.SPDR, 0x66); // Write collision.
        source.runCycles(32);
        const avr = restored ? A.AVR().restore(source.snapshot()) : source;
        avr.cpu.sreg.I = true;
        avr.step();
        expect(avr.cpu.pc).toBe(A.SPI_STC_VECTOR);
        avr.cpu.readData(A.SPDR);
        expect(avr.cpu.data[A.SPSR]! & bit(A.WCOL)).toBe(bit(A.WCOL));
        avr.cpu.readData(A.SPSR);
        avr.cpu.readData(A.SPDR);
        expect(avr.cpu.data[A.SPSR]! & bit(A.WCOL)).toBe(0);
      });

      test(`TWI re-enters until firmware clears TWINT (${restored ? "restored" : "direct"})`, () => {
        const source = A.AVR({ timing });
        source.cpu.flash[0] = 0xcfff; // Main loop.
        source.cpu.flash[A.TWI_VECTOR] = 0x9518; // RETI without clearing TWINT.
        source.cpu.writeData(A.TWCR, bit(A.TWEN) | bit(A.TWIE) | bit(A.TWSTA) | bit(A.TWINT));
        source.runCycles(2);
        source.cpu.sreg.I = true;
        source.step();
        expect(source.cpu.pc).toBe(A.TWI_VECTOR);
        // Restore while already in the ISR, before RETI.
        const avr = restored ? A.AVR().restore(source.snapshot()) : source;
        avr.step();
        expect(avr.cpu.pc).toBe(0);
        avr.step();
        expect(avr.cpu.pc).toBe(A.TWI_VECTOR);
        avr.cpu.writeData(A.TWCR, bit(A.TWEN) | bit(A.TWIE) | bit(A.TWINT) | bit(A.TWSTO));
        avr.step();
        avr.step();
        expect(avr.cpu.pc).toBe(0);
        expect(avr.snapshot().cpu.pendingInterrupts).not.toContain(A.TWI_VECTOR);
      });
    }

    test("SPSR writes preserve read-only flags and cannot fabricate SPI interrupts", () => {
      const avr = A.AVR({ timing });
      avr.cpu.writeData(A.DDRB, bit(2));
      avr.cpu.writeData(A.SPCR, bit(A.SPE) | bit(A.MSTR) | bit(A.SPIE));
      avr.cpu.writeData(A.SPSR, bit(A.SPIF) | bit(A.WCOL) | 0x3e);
      expect(avr.cpu.data[A.SPSR]).toBe(0);
      avr.cpu.writeData(A.SPDR, 0x55);
      avr.cpu.writeData(A.SPDR, 0x66);
      avr.runCycles(32);
      avr.cpu.writeData(A.SPSR, bit(A.SPI2X));
      expect(avr.cpu.data[A.SPSR]).toBe(bit(A.SPIF) | bit(A.WCOL) | bit(A.SPI2X));
      avr.cpu.sreg.I = true;
      avr.step();
      expect(avr.cpu.pc).toBe(A.SPI_STC_VECTOR);
    });

    test("restoring a legacy TWI snapshot reasserts an uncleared TWINT", () => {
      const source = A.AVR({ timing });
      source.cpu.writeData(A.TWCR, bit(A.TWEN) | bit(A.TWIE) | bit(A.TWSTA) | bit(A.TWINT));
      source.runCycles(1);
      const snapshot = source.snapshot();
      snapshot.cpu.pendingInterrupts = []; // Older ISR-entry snapshots consumed the request.
      const avr = A.AVR().restore(snapshot);
      avr.cpu.sreg.I = true;
      avr.step();
      expect(avr.cpu.pc).toBe(A.TWI_VECTOR);
    });

    test("external ADC triggers need ADATE, not ADSC, and clear busy after completion", () => {
      const avr = A.AVR({ timing });
      avr.analog(0).setValue(345);
      avr.cpu.writeData(A.ADCSRB, bit(A.ADTS0) | bit(A.ADTS1)); // Timer0 compare A.
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADATE));
      avr.cpu.writeData(A.OCR0A, 3);
      avr.cpu.writeData(A.TCCR0A, bit(A.WGM01));
      avr.cpu.writeData(A.TCCR0B, bit(A.CS00));
      avr.runCycles(4);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADSC)).toBe(bit(A.ADSC));
      avr.runCycles(60);
      expect(result(avr)).toBe(345);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADSC)).toBe(0);
      avr.analog(0).setValue(678);
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADATE) | bit(A.ADIF));
      avr.cpu.writeData(A.TIFR0, bit(A.OCF0A));
      avr.runCycles(40);
      expect(result(avr)).toBe(678);
    });

    test("ADSC starts a single conversion with an external auto-trigger selected", () => {
      const avr = A.AVR({ timing });
      avr.analog(0).setValue(345);
      avr.cpu.writeData(A.ADCSRB, bit(A.ADTS0) | bit(A.ADTS1));
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADATE) | bit(A.ADSC));
      avr.runCycles(50);
      expect(result(avr)).toBe(345);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADSC)).toBe(0);
    });

    test("free-running mode waits for ADSC before its first conversion", () => {
      const avr = A.AVR({ timing });
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADATE));
      avr.runCycles(60);
      expect(avr.cpu.readData(A.ADCSRA) & (bit(A.ADSC) | bit(A.ADIF))).toBe(0);
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADATE) | bit(A.ADSC));
      avr.runCycles(50);
      expect(avr.cpu.readData(A.ADCSRA) & (bit(A.ADSC) | bit(A.ADIF))).toBe(bit(A.ADSC) | bit(A.ADIF));
    });

    test("analog comparator events trigger ADC conversions independently of ACIE", () => {
      const avr = A.AVR({ timing });
      avr.analog(0).setValue(345);
      avr.comparator.setInput("ain1", 1);
      avr.cpu.writeData(A.ACSR, bit(A.ACIS0) | bit(A.ACIS1));
      avr.cpu.writeData(A.ADCSRB, bit(A.ADTS0));
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADATE));
      avr.comparator.setInput("ain0", 2);
      avr.runCycles(60);
      expect(result(avr)).toBe(345);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADIF)).toBe(bit(A.ADIF));
    });

    test("an external trigger edge during conversion is ignored until a fresh edge", () => {
      const avr = A.AVR({ timing });
      avr.comparator.setInput("ain1", 1);
      avr.cpu.writeData(A.ACSR, bit(A.ACIS0) | bit(A.ACIS1));
      avr.cpu.writeData(A.ADCSRB, bit(A.ADTS0));
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADATE) | bit(A.ADSC));
      avr.runCycles(10);
      avr.comparator.setInput("ain0", 2);
      avr.runCycles(60);
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADATE) | bit(A.ADIF));
      avr.runCycles(30);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADIF)).toBe(0);
      avr.cpu.writeData(A.ACSR, bit(A.ACIS0) | bit(A.ACIS1) | bit(A.ACI));
      avr.runCycles(1);
      avr.comparator.setInput("ain0", 0);
      avr.comparator.setInput("ain0", 2);
      avr.runCycles(30);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADIF)).toBe(bit(A.ADIF));
    });

    test("ADLAR changes the existing result immediately, including while read-locked", () => {
      const avr = A.AVR({ timing });
      avr.analog(0).setValue(0x2ab);
      warm(avr);
      avr.cpu.readData(A.ADCL);
      avr.cpu.writeData(A.ADMUX, bit(A.ADLAR));
      expect(avr.cpu.readData(A.ADCL)).toBe(0xc0);
      expect(avr.cpu.readData(A.ADCH)).toBe(0xaa);
      avr.cpu.writeData(A.ADMUX, 0);
      expect(result(avr)).toBe(0x2ab);
      avr.analog(0).setValue(0x155);
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC));
      avr.runCycles(10);
      avr.cpu.writeData(A.ADMUX, bit(A.ADLAR));
      expect(avr.cpu.readData(A.ADCH)).toBe(0xaa);
      avr.runCycles(16);
      expect(avr.cpu.readData(A.ADCL)).toBe(0x40);
      expect(avr.cpu.readData(A.ADCH)).toBe(0x55);
    });

    for (const first of [true, false]) {
      test(`ADC holds the input at the ${first ? "first" : "normal"} conversion sampling boundary`, () => {
        const avr = A.AVR({ timing });
        if (!first) warm(avr);
        avr.analog(0).setValue(100);
        avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC));
        const sampleAt = first ? 27 : 3; // 13.5 or 1.5 ADC clocks at /2.
        avr.runCycles(sampleAt - 1);
        avr.analog(0).setValue(200);
        avr.runCycles(1);
        avr.analog(0).setValue(900);
        avr.runCycles((first ? 50 : 26) - sampleAt);
        expect(result(avr)).toBe(200);
      });
    }

    for (const beforeSample of [true, false]) {
      test(`ADC sample timing and held value survive power reduction and restore (${beforeSample ? "before" : "after"} sampling)`, () => {
        const source = A.AVR({ timing });
        warm(source);
        source.analog(0).setValue(100);
        source.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC));
        source.runCycles(beforeSample ? 1 : 5);
        source.cpu.writeData(A.PRR, bit(A.PRADC));
        source.runCycles(60);
        source.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC));
        const avr = A.AVR().restore(source.snapshot());
        avr.analog(0).setValue(200);
        avr.runCycles(60);
        expect(result(avr)).toBe(0);
        avr.cpu.writeData(A.PRR, 0);
        if (beforeSample) {
          avr.runCycles(2);
          avr.analog(0).setValue(900);
          avr.runCycles(23);
        } else {
          avr.runCycles(21);
        }
        expect(result(avr)).toBe(beforeSample ? 200 : 100);
      });
    }
  });
}
