import { describe, expect, test } from "bun:test";
import { CPU, Decoder, FLASH_WORDS, PORTB, RAMEND } from "../src/cpu";

function makeCpu(program: number[]): CPU {
  const flash = new Uint16Array(FLASH_WORDS); // full flash; unused words = 0x0000 (NOP)
  flash.set(program);
  const cpu = new CPU(flash);
  cpu.setExecutor(new Decoder());
  return cpu;
}

describe("control flow", () => {
  test("add/dec/brne loop sums 3+2+1 = 6", () => {
    const cpu = makeCpu([
      0xe003, // ldi r16, 3   (counter)
      0xe010, // ldi r17, 0   (accumulator)
      0x0f10, // add r17, r16
      0x950a, // dec r16
      0xf7e9, // brne -3      (back to add)
      0xcfff, // rjmp -1
    ]);
    cpu.run(100);
    expect(cpu.data[17]).toBe(6);
    expect(cpu.data[16]).toBe(0);
  });

  test("RCALL/RET runs a subroutine and balances the stack", () => {
    const cpu = makeCpu([
      0xea0a, // ldi r16, 0xAA
      0xd001, // rcall +1  -> [3]
      0xcfff, // rjmp -1    (return lands here)
      0x2f10, // mov r17, r16   (subroutine)
      0x9508, // ret
    ]);
    for (let i = 0; i < 4; i += 1) cpu.tick(); // ldi, rcall, mov, ret
    expect(cpu.data[17]).toBe(0xaa);
    expect(cpu.pc).toBe(2);
    expect(cpu.SP).toBe(RAMEND); // pushed then popped
  });

  test("PUSH/POP move a byte through the stack", () => {
    const cpu = makeCpu([
      0xe30c, // ldi r16, 0x3C
      0x930f, // push r16
      0xe000, // ldi r16, 0x00
      0x911f, // pop r17
    ]);
    for (let i = 0; i < 4; i += 1) cpu.tick();
    expect(cpu.data[16]).toBe(0x00);
    expect(cpu.data[17]).toBe(0x3c);
    expect(cpu.SP).toBe(RAMEND);
  });

  test("CP + BREQ taken skips the next instruction", () => {
    const cpu = makeCpu([
      0xe005, // ldi r16, 5
      0xe015, // ldi r17, 5
      0x1701, // cp r16, r17   -> equal, Z=1
      0xf009, // breq +1        -> taken
      0xef0f, // ldi r16, 0xFF  -> skipped
    ]);
    for (let i = 0; i < 4; i += 1) cpu.tick();
    expect(cpu.sreg.Z).toBe(true);
    expect(cpu.data[16]).toBe(5); // not overwritten
    expect(cpu.pc).toBe(5);
  });
});

describe("logic & shifts", () => {
  test("OR / AND / COM produce expected bytes", () => {
    const cpu = makeCpu([
      0xef00, // ldi r16, 0xF0
      0xe01f, // ldi r17, 0x0F
      0x2f20, // mov r18, r16
      0x2b21, // or  r18, r17  -> 0xFF
      0x2301, // and r16, r17  -> 0x00
      0x9510, // com r17       -> 0xF0, C=1
    ]);
    for (let i = 0; i < 6; i += 1) cpu.tick();
    expect(cpu.data[18]).toBe(0xff);
    expect(cpu.data[16]).toBe(0x00);
    expect(cpu.data[17]).toBe(0xf0);
    expect(cpu.sreg.C).toBe(true);
  });

  test("INC 0x7F sets overflow + negative", () => {
    const cpu = makeCpu([
      0xe70f, // ldi r16, 0x7F
      0x9503, // inc r16
    ]);
    cpu.run(2);
    expect(cpu.data[16]).toBe(0x80);
    expect(cpu.sreg.V).toBe(true);
    expect(cpu.sreg.N).toBe(true);
  });
});

describe("memory", () => {
  test("ST X+ then LD -X round-trips through SRAM", () => {
    const cpu = makeCpu([
      0xe0a0, // ldi r26, 0x00  (X low)
      0xe0b1, // ldi r27, 0x01  (X high) -> X = 0x0100
      0xe70e, // ldi r16, 0x7E
      0x930d, // st X+, r16     -> data[0x100]=0x7E, X=0x101
      0x911e, // ld r17, -X     -> X=0x100, r17=0x7E
    ]);
    cpu.run(2 + 1 + 2 + 2);
    expect(cpu.readData(0x100)).toBe(0x7e);
    expect(cpu.data[17]).toBe(0x7e);
    expect(cpu.data[26]! | (cpu.data[27]! << 8)).toBe(0x100);
  });

  test("STD Z+q / LDD Z+q use the displacement", () => {
    const cpu = makeCpu([
      0xe0e0, // ldi r30, 0x00 (Z low)
      0xe0f1, // ldi r31, 0x01 (Z high) -> Z = 0x0100
      0xe50a, // ldi r16, 0x5A
      0x8304, // std Z+4, r16  -> data[0x104]
      0x8114, // ldd r17, Z+4  -> r17
    ]);
    cpu.run(20);
    expect(cpu.readData(0x104)).toBe(0x5a);
    expect(cpu.data[17]).toBe(0x5a);
  });

  test("LPM reads low then high byte of a flash word", () => {
    const cpu = makeCpu([
      0xe0ea, // ldi r30, 0x0A  (byte addr 10 -> word 5, low)
      0xe0f0, // ldi r31, 0x00
      0x9105, // lpm r16, Z+    -> low byte of flash[5]
      0x9114, // lpm r17, Z     -> high byte of flash[5]
      0xcfff, // rjmp -1
      0xbeef, // <data> flash word 5
    ]);
    for (let i = 0; i < 4; i += 1) cpu.tick();
    expect(cpu.data[16]).toBe(0xef);
    expect(cpu.data[17]).toBe(0xbe);
  });

  test("LDS / STS are two-word and advance pc by 2", () => {
    const cpu = makeCpu([
      0xe30c, // ldi r16, 0x3C
      0x9300, // sts ... , r16   (2-word)
      0x0100, //   -> address 0x0100
      0x9110, // lds r17, ...     (2-word)
      0x0100, //   -> address 0x0100
    ]);
    cpu.tick(); // ldi
    cpu.tick(); // sts (pc 1 -> 3)
    expect(cpu.pc).toBe(3);
    cpu.tick(); // lds (pc 3 -> 5)
    expect(cpu.pc).toBe(5);
    expect(cpu.readData(0x100)).toBe(0x3c);
    expect(cpu.data[17]).toBe(0x3c);
  });
});

describe("16-bit ops", () => {
  test("ADIW then SBIW cross the byte boundary", () => {
    const cpu = makeCpu([
      0xef8f, // ldi r24, 0xFF
      0xe090, // ldi r25, 0x00  -> pair = 0x00FF
      0x9601, // adiw r24, 1     -> 0x0100
      0x9701, // sbiw r24, 1     -> 0x00FF
    ]);
    cpu.run(2 + 2); // through adiw
    expect(cpu.data[24]).toBe(0x00);
    expect(cpu.data[25]).toBe(0x01);
    cpu.run(2); // sbiw
    expect(cpu.data[24]).toBe(0xff);
    expect(cpu.data[25]).toBe(0x00);
  });

  test("MOVW copies a register pair", () => {
    const cpu = makeCpu([
      0xe102, // ldi r16, 0x12
      0xe314, // ldi r17, 0x34
      0x0198, // movw r18, r16
    ]);
    cpu.run(3);
    expect(cpu.data[18]).toBe(0x12);
    expect(cpu.data[19]).toBe(0x34);
  });
});

describe("skip instructions", () => {
  test("CPSE skips one word when equal", () => {
    const cpu = makeCpu([
      0xe005, // ldi r16, 5
      0xe015, // ldi r17, 5
      0x1301, // cpse r16, r17  -> equal, skip next
      0xef0f, // ldi r16, 0xFF  -> skipped
      0xea2a, // ldi r18, 0xAA  -> executed
    ]);
    for (let i = 0; i < 4; i += 1) cpu.tick();
    expect(cpu.data[16]).toBe(5);
    expect(cpu.data[18]).toBe(0xaa);
    expect(cpu.pc).toBe(5);
  });

  test("CPSE skips TWO words when the next instruction is 32-bit (LDS)", () => {
    const cpu = makeCpu([
      0xe005, // ldi r16, 5
      0xe015, // ldi r17, 5
      0x1301, // cpse r16, r17  -> equal, skip 2-word LDS
      0x9120, // lds r18, ...   -> skipped (word 1)
      0x0100, //   -> skipped (word 2)
      0xeb3b, // ldi r19, 0xBB  -> executed
    ]);
    for (let i = 0; i < 4; i += 1) cpu.tick();
    expect(cpu.data[18]).toBe(0); // lds never ran
    expect(cpu.data[19]).toBe(0xbb);
    expect(cpu.pc).toBe(6);
  });

  test("SBRC skips when the tested bit is clear", () => {
    const cpu = makeCpu([
      0xe002, // ldi r16, 0x02  (bit0 clear)
      0xfd00, // sbrc r16, 0     -> skip
      0xef1f, // ldi r17, 0xFF   -> skipped
      0xe121, // ldi r18, 0x11   -> executed
    ]);
    for (let i = 0; i < 3; i += 1) cpu.tick();
    expect(cpu.data[17]).toBe(0);
    expect(cpu.data[18]).toBe(0x11);
  });

  test("SBI/CBI set & clear an I/O bit; SBIC skips when clear", () => {
    const cpu = makeCpu([
      0x9a2b, // sbi 0x05, 3   -> PORTB bit3 = 1
      0x982a, // cbi 0x05, 2   -> PORTB bit2 = 0 (already)
      0x992a, // sbic 0x05, 2  -> bit2 clear -> skip
      0xef0f, // ldi r16, 0xFF -> skipped
      0xe007, // ldi r16, 0x07 -> executed
    ]);
    for (let i = 0; i < 4; i += 1) cpu.tick();
    expect(cpu.readData(PORTB) & 0x08).toBe(0x08); // bit3 set by sbi
    expect(cpu.data[16]).toBe(0x07);
  });
});

describe("two-word jumps", () => {
  test("JMP transfers control to the absolute address", () => {
    const cpu = makeCpu([
      0x940c, // jmp 0x0004
      0x0004, //   -> address
      0xef0f, // ldi r16, 0xFF -> skipped
      0xcfff, // rjmp -1       -> skipped
      0xe707, // ldi r16, 0x77 -> target
    ]);
    cpu.tick(); // jmp
    expect(cpu.pc).toBe(4);
    cpu.tick(); // ldi r16, 0x77
    expect(cpu.data[16]).toBe(0x77);
  });

  test("CALL pushes the return address; RET comes back", () => {
    const cpu = makeCpu([
      0x940e, // call 0x0004
      0x0004, //   -> address
      0xcfff, // rjmp -1       (return target)
      0x0000, // (padding)
      0xe909, // ldi r16, 0x99 (subroutine)
      0x9508, // ret
    ]);
    cpu.tick(); // call -> pc 4
    expect(cpu.pc).toBe(4);
    cpu.tick(); // ldi r16, 0x99
    cpu.tick(); // ret -> pc 2
    expect(cpu.data[16]).toBe(0x99);
    expect(cpu.pc).toBe(2);
    expect(cpu.SP).toBe(RAMEND);
  });
});
