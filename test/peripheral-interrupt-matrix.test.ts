import { describe, expect, test } from "bun:test";
import * as A from "../src";

type Avr = ReturnType<typeof A.AVR>;
const bit = (n: number) => 1 << n;
const pending = (avr: Avr) => avr.snapshot().cpu.pendingInterrupts;
// Vector order from INT0 through SPM_READY; ready sources have no separate flag.
const flags = [
  [A.EIFR, A.INTF0], [A.EIFR, A.INTF1],
  [A.PCIFR, 0], [A.PCIFR, 1], [A.PCIFR, 2], [A.WDTCSR, A.WDIF],
  [A.TIFR2, A.OCF2A], [A.TIFR2, A.OCF2B], [A.TIFR2, A.TOV2],
  [A.TIFR1, A.ICF1], [A.TIFR1, A.OCF1A], [A.TIFR1, A.OCF1B], [A.TIFR1, A.TOV1],
  [A.TIFR0, A.OCF0A], [A.TIFR0, A.OCF0B], [A.TIFR0, A.TOV0],
  [A.SPSR, A.SPIF], [A.UCSR0A, A.RXC0], [A.UCSR0A, A.UDRE0], [A.UCSR0A, A.TXC0],
  [A.ADCSRA, A.ADIF], null, [A.ACSR, A.ACI], [A.TWCR, A.TWINT], null,
] as const;
type Source = {
  name: string;
  vector: number;
  level?: boolean;
  prepare(avr: Avr, enabled: boolean): void;
  enable(avr: Avr, enabled: boolean): void;
  clear(avr: Avr): void;
};

const sources: Source[] = [];
for (const timer of [0, 1, 2] as const) {
  for (const kind of ["A", "B", "overflow"] as const) {
    const control = timer === 0 ? A.TCCR0B : timer === 1 ? A.TCCR1B : A.TCCR2B;
    const maskReg = timer === 0 ? A.TIMSK0 : timer === 1 ? A.TIMSK1 : A.TIMSK2;
    const flagReg = timer === 0 ? A.TIFR0 : timer === 1 ? A.TIFR1 : A.TIFR2;
    const flag = kind === "A" ? 1 : kind === "B" ? 2 : 0;
    const vector = timer === 0
      ? kind === "A" ? A.TIMER0_COMPA_VECTOR : kind === "B" ? A.TIMER0_COMPB_VECTOR : A.TIMER0_OVF_VECTOR
      : timer === 1
        ? kind === "A" ? A.TIMER1_COMPA_VECTOR : kind === "B" ? A.TIMER1_COMPB_VECTOR : A.TIMER1_OVF_VECTOR
        : kind === "A" ? A.TIMER2_COMPA_VECTOR : kind === "B" ? A.TIMER2_COMPB_VECTOR : A.TIMER2_OVF_VECTOR;
    sources.push({
      name: `Timer${timer} ${kind}`, vector,
      prepare(avr, enabled) {
        avr.cpu.writeData(maskReg, enabled ? bit(flag) : 0);
        if (kind === "overflow") {
          if (timer === 1) avr.cpu.writeData(A.TCNT1H, 0xff);
          avr.cpu.writeData(timer === 0 ? A.TCNT0 : timer === 1 ? A.TCNT1L : A.TCNT2, 0xff);
        } else {
          const ocr = timer === 0 ? kind === "A" ? A.OCR0A : A.OCR0B
            : timer === 1 ? kind === "A" ? A.OCR1AL : A.OCR1BL : kind === "A" ? A.OCR2A : A.OCR2B;
          avr.cpu.writeData(ocr, 1);
        }
        avr.cpu.writeData(control, 1);
        avr.runCycles(1);
        avr.cpu.writeData(control, 0);
      },
      enable(avr, enabled) { avr.cpu.writeData(maskReg, enabled ? bit(flag) : 0); },
      clear(avr) { avr.cpu.writeData(flagReg, bit(flag)); },
    });
  }
}
sources.push({
  name: "Timer1 capture", vector: A.TIMER1_CAPT_VECTOR,
  prepare(avr, enabled) {
    avr.cpu.writeData(A.TCCR1B, bit(A.ICES1));
    avr.cpu.writeData(A.TIMSK1, enabled ? bit(A.ICIE1) : 0);
    avr.pin(8).setInput(true);
  },
  enable(avr, enabled) { avr.cpu.writeData(A.TIMSK1, enabled ? bit(A.ICIE1) : 0); },
  clear(avr) { avr.cpu.writeData(A.TIFR1, bit(A.ICF1)); },
});
for (const bank of [0, 1, 2] as const) {
  sources.push({
    name: `PCINT${bank}`, vector: bank === 0 ? A.PCINT0_VECTOR : bank === 1 ? A.PCINT1_VECTOR : A.PCINT2_VECTOR,
    prepare(avr, enabled) {
      avr.cpu.writeData(bank === 0 ? A.PCMSK0 : bank === 1 ? A.PCMSK1 : A.PCMSK2, bit(0));
      avr.cpu.writeData(A.PCICR, enabled ? bit(bank) : 0);
      avr.pin(bank === 0 ? 8 : bank === 1 ? 14 : 0).setInput(true);
    },
    enable(avr, enabled) { avr.cpu.writeData(A.PCICR, enabled ? bit(bank) : 0); },
    clear(avr) { avr.cpu.writeData(A.PCIFR, bit(bank)); },
  });
}
for (const pin of [0, 1] as const) {
  sources.push({
    name: `INT${pin}`, vector: pin === 0 ? A.INT0_VECTOR : A.INT1_VECTOR,
    prepare(avr, enabled) {
      avr.cpu.writeData(A.EICRA, 3 << (pin * 2));
      avr.cpu.writeData(A.EIMSK, enabled ? bit(pin) : 0);
      avr.pin(pin + 2).setInput(true);
    },
    enable(avr, enabled) { avr.cpu.writeData(A.EIMSK, enabled ? bit(pin) : 0); },
    clear(avr) { avr.cpu.writeData(A.EIFR, bit(pin)); },
  });
}
for (const kind of ["RX", "UDRE", "TX"] as const) {
  const mask = kind === "RX" ? A.RXCIE0 : kind === "UDRE" ? A.UDRIE0 : A.TXCIE0;
  const control = bit(A.RXEN0) | bit(A.TXEN0);
  sources.push({
    name: `USART ${kind}`, vector: kind === "RX" ? A.USART_RX_VECTOR : kind === "UDRE" ? A.USART_UDRE_VECTOR : A.USART_TX_VECTOR,
    level: kind !== "TX",
    prepare(avr, enabled) {
      avr.cpu.writeData(A.UCSR0B, control | (enabled ? bit(mask) : 0));
      if (kind === "RX") { avr.serial.write("A"); avr.runCycles(176); }
      if (kind === "TX") { avr.cpu.writeData(A.UDR0, 0x41); avr.runCycles(176); }
    },
    enable(avr, enabled) { avr.cpu.writeData(A.UCSR0B, control | (enabled ? bit(mask) : 0)); },
    clear(avr) {
      if (kind === "RX") avr.cpu.readData(A.UDR0);
      if (kind === "UDRE") { avr.cpu.writeData(A.UDR0, 1); avr.cpu.writeData(A.UDR0, 2); }
      if (kind === "TX") avr.cpu.writeData(A.UCSR0A, bit(A.TXC0));
    },
  });
}
for (const kind of ["EEPROM", "SPM"] as const) {
  const addr = kind === "EEPROM" ? A.EECR : A.SPMCSR;
  const mask = kind === "EEPROM" ? A.EERIE : A.SPMIE;
  sources.push({
    name: `${kind} ready`, vector: kind === "EEPROM" ? A.EE_READY_VECTOR : A.SPM_READY_VECTOR, level: true,
    prepare(avr, enabled) { avr.cpu.writeData(addr, enabled ? bit(mask) : 0); },
    enable(avr, enabled) { avr.cpu.writeData(addr, enabled ? bit(mask) : 0); },
    clear(avr) { avr.cpu.writeData(addr, 0); },
  });
}
sources.push({
  name: "watchdog", vector: A.WDT_VECTOR,
  prepare(avr, enabled) {
    avr.cpu.writeData(A.WDTCSR, bit(A.WDIE));
    avr.runCycles(16);
    if (!enabled) avr.cpu.writeData(A.WDTCSR, 0);
  },
  enable(avr, enabled) { avr.cpu.writeData(A.WDTCSR, enabled ? bit(A.WDIE) : 0); },
  clear(avr) { avr.cpu.writeData(A.WDTCSR, bit(A.WDIE) | bit(A.WDIF)); },
}, {
  name: "ADC", vector: A.ADC_VECTOR,
  prepare(avr, enabled) {
    avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC) | (enabled ? bit(A.ADIE) : 0));
    avr.runCycles(50);
  },
  enable(avr, enabled) { avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | (enabled ? bit(A.ADIE) : 0)); },
  clear(avr) { avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADIE) | bit(A.ADIF)); },
}, {
  name: "SPI", vector: A.SPI_STC_VECTOR,
  prepare(avr, enabled) {
    avr.cpu.writeData(A.DDRB, bit(2));
    avr.cpu.writeData(A.SPCR, bit(A.SPE) | bit(A.MSTR) | (enabled ? bit(A.SPIE) : 0));
    avr.cpu.writeData(A.SPDR, 0x41);
    avr.runCycles(32);
  },
  enable(avr, enabled) { avr.cpu.writeData(A.SPCR, bit(A.SPE) | bit(A.MSTR) | (enabled ? bit(A.SPIE) : 0)); },
  clear(avr) { avr.cpu.readData(A.SPSR); avr.cpu.readData(A.SPDR); },
}, {
  name: "TWI", vector: A.TWI_VECTOR, level: true,
  prepare(avr, enabled) {
    avr.cpu.writeData(A.TWCR, bit(A.TWEN) | bit(A.TWINT) | bit(A.TWSTA) | (enabled ? bit(A.TWIE) : 0));
    avr.runCycles(1);
  },
  enable(avr, enabled) { avr.cpu.writeData(A.TWCR, bit(A.TWEN) | (enabled ? bit(A.TWIE) : 0)); },
  clear(avr) { avr.cpu.writeData(A.TWCR, bit(A.TWEN) | bit(A.TWIE) | bit(A.TWINT)); },
}, {
  name: "comparator", vector: A.ANALOG_COMP_VECTOR,
  prepare(avr, enabled) {
    avr.comparator.setInput("ain1", 1);
    avr.cpu.writeData(A.ACSR, bit(A.ACIS0) | bit(A.ACIS1) | (enabled ? bit(A.ACIE) : 0));
    avr.comparator.setInput("ain0", 2);
  },
  enable(avr, enabled) { avr.cpu.writeData(A.ACSR, bit(A.ACIS0) | bit(A.ACIS1) | (enabled ? bit(A.ACIE) : 0)); },
  clear(avr) { avr.cpu.writeData(A.ACSR, bit(A.ACIS0) | bit(A.ACIS1) | bit(A.ACIE) | bit(A.ACI)); },
});

for (const timing of ["fast", "cycle-exact"] as const) {
  describe(`${timing}: all 25 peripheral interrupt sources`, () => {
    test("the matrix covers each peripheral vector exactly once", () => {
      expect(sources.map(source => source.vector).sort((a, b) => a - b))
        .toEqual(Array.from({ length: 25 }, (_, index) => (index + 1) * 2));
    });
    for (const source of sources) {
      for (const restore of [false, true]) {
        test(`${source.name}, ${restore ? "restored" : "direct"}: masks, acknowledgement, and clearing track live state`, () => {
          const initial = A.AVR({ timing, clockHz: 1000 });
          source.prepare(initial, true);
          expect(pending(initial)).toContain(source.vector);
          const avr = restore ? A.AVR().restore(initial.snapshot()) : initial;
          source.enable(avr, false);
          expect(pending(avr)).not.toContain(source.vector);
          const flag = flags[source.vector / 2 - 1];
          if (flag) expect(avr.cpu.readData(flag[0]) & bit(flag[1])).toBe(bit(flag[1]));
          source.enable(avr, true);
          expect(pending(avr)).toContain(source.vector);
          avr.cpu.sreg.I = true;
          avr.step();
          expect(avr.cpu.pc).toBe(source.vector);
          expect(pending(avr).includes(source.vector)).toBe(source.level === true);
          if (flag) expect(avr.cpu.readData(flag[0]) & bit(flag[1])).toBe(source.level ? bit(flag[1]) : 0);
          source.clear(avr);
          expect(pending(avr)).not.toContain(source.vector);
        });
      }
      test(`${source.name}: enabling an already-latched source delivers the request`, () => {
        const avr = A.AVR({ timing, clockHz: 1000 });
        source.prepare(avr, false);
        expect(pending(avr)).not.toContain(source.vector);
        source.enable(avr, true);
        expect(pending(avr)).toContain(source.vector);
        source.clear(avr);
        expect(pending(avr)).not.toContain(source.vector);
      });
    }
  });
}
