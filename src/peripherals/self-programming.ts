import { OnWrite } from "../core";
import {
  BLBSET,
  EECR,
  EEPE,
  FLASH_WORDS,
  PGERS,
  PGWRT,
  RWWSB,
  RWWSRE,
  SELFPRGEN,
  SIGRD,
  SPM_READY_VECTOR,
  SPMCSR,
  SPMIE,
} from "../cpu";
import type { CPU } from "../cpu";
import { WallClockTimer } from "./wall-clock-timer";
import type { SelfProgrammingSnapshot } from "../snapshot";

interface FuseBytes {
  low: number;
  high: number;
  extended: number;
  lockBits: number;
}

interface PendingSpmOperation {
  kind: "erase" | "write" | "lock" | "rww";
  pageBase: number;
  lockValue: number;
}

const PAGE_WORDS = 64;
const PAGE_MASK = PAGE_WORDS - 1;
const COMMAND_MASK =
  (1 << SELFPRGEN) | (1 << PGERS) | (1 << PGWRT) | (1 << BLBSET) | (1 << RWWSRE) | (1 << SIGRD);
const CONTROL_MASK = COMMAND_MASK | (1 << SPMIE);
const SPM_COMMAND_CYCLES = 4;
const FLASH_PROGRAMMING_MS = 4.1; // Deterministic midpoint of the 3.7..4.5 ms range.
// Table 27-14: the RWW boundary is independent of the BOOTSZ fuse.
const NRWW_START_WORD = 0x3800;
const BLB01 = 2;
const BLB02 = 3;
const BLB11 = 4;
const BLB12 = 5;

/**
 * ATmega328P self-programming support. The model is intentionally AVR-visible:
 * SPMCSR command bits, LPM fuse/lock/signature reads, page buffer fill,
 * erase/write, RWWSRE, and SPM_READY are modeled; analog flash wear is not.
 */
export class SelfProgramming {
  private readonly pageBuffer = new Uint16Array(PAGE_WORDS);
  private pendingOperation: PendingSpmOperation | null = null;
  private pendingPageData: Uint16Array | undefined;
  private readonly programming: WallClockTimer;
  private readonly fetchBlocked = () => {
    const pending = this.pendingOperation;
    if (pending && (pending.kind === "erase" || pending.kind === "write") && pending.pageBase >= NRWW_START_WORD) return true;
    return this.cpu.pc < NRWW_START_WORD && ((pending !== null && (pending.kind === "erase" || pending.kind === "write")) || (this.cpu.data[SPMCSR]! & (1 << RWWSB)) !== 0);
  };

  private readonly clearCommandEvent = (): void => {
    this.clearCommandBits();
  };


  constructor(
    private readonly cpu: CPU,
    private readonly fuses: () => FuseBytes,
    private readonly setLockBits: (lockBits: number) => void,
    private readonly bootStartWord: () => number,
    private readonly onReadyChange: () => void = () => {},
  ) {
    this.programming = new WallClockTimer(cpu, () => this.completePendingOperation());
    this.pageBuffer.fill(0xffff);
    this.cpu.setSpmInstructionHook((pc) => this.executeSpm(pc));
    this.cpu.setProgramMemoryReadHook((byteAddr, readerPc) =>
      this.readSpecialProgramByte(byteAddr, readerPc),
    );
  }

  setClock(hz: number): void { this.programming.setClock(hz); }

  reset(): void {
    this.programming.stop();
    this.pendingPageData = undefined;
    this.cpu.setInstructionBarrier(undefined);
    this.pageBuffer.fill(0xffff);
    this.pendingOperation = null;
    this.cpu.clearClockEvent(this.clearCommandEvent);
    this.cpu.data[SPMCSR] = 0;
  }

  @OnWrite(SPMCSR)
  onWriteSpmcsr(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    if (this.pendingOperation !== null) {
      this.cpu.data[SPMCSR] = (oldValue & ~ (1 << SPMIE)) | (value & (1 << SPMIE));
      this.updateInterrupt();
      return;
    }
    const status = oldValue & (1 << RWWSB);
    this.cpu.data[SPMCSR] = (value & CONTROL_MASK) | status;
    this.cpu.clearClockEvent(this.clearCommandEvent);
    if ((value & (1 << SELFPRGEN)) !== 0) {
      this.cpu.addClockEvent(this.clearCommandEvent, SPM_COMMAND_CYCLES);
    }
    this.updateInterrupt();
  }

  /** Ready stays asserted until firmware disables SPMIE or starts a command. */
  updateInterrupt(): void {
    const control = this.cpu.data[SPMCSR]!;
    if ((control & ((1 << SPMIE) | (1 << SELFPRGEN))) === (1 << SPMIE) && this.pendingOperation === null && (this.cpu.data[EECR]! & (1 << EEPE)) === 0) {
      this.cpu.requestInterrupt(SPM_READY_VECTOR, () => this.updateInterrupt());
    } else {
      this.cpu.clearInterrupt(SPM_READY_VECTOR);
    }
    this.onReadyChange();
  }

  snapshot(): SelfProgrammingSnapshot {
    return {
      pageBuffer: new Uint16Array(this.pageBuffer),
      pendingOperation: this.pendingOperation?.kind ?? null,
      pendingPageBase: this.pendingOperation?.pageBase ?? 0,
      pendingLockValue: this.pendingOperation?.lockValue ?? 0xff,
      pendingRemainingCycles:
        this.pendingOperation === null ? 0 : this.programming.remainingCycles(),
      pendingRemainingMs: this.programming.remainingMs(),
      pendingPageData: this.pendingPageData?.slice(),
      commandClearRemainingCycles: this.cpu.clockEventRemainingCycles(this.clearCommandEvent),
    };
  }

  restore(snap: SelfProgrammingSnapshot | undefined): void {
    this.cpu.clearClockEvent(this.clearCommandEvent);
    this.programming.stop();
    this.pendingPageData = undefined;
    this.cpu.setInstructionBarrier(undefined);
    this.pageBuffer.fill(0xffff);
    if (snap?.pageBuffer) this.pageBuffer.set(snap.pageBuffer.subarray(0, PAGE_WORDS));
    this.pendingOperation =
      snap?.pendingOperation == null
        ? null
        : {
            kind: snap.pendingOperation,
            pageBase: snap.pendingPageBase ?? 0,
            lockValue: snap.pendingLockValue ?? 0xff,
          };
    if (this.pendingOperation !== null) {
      this.pendingPageData = snap?.pendingPageData?.slice() ?? new Uint16Array(this.pageBuffer);
      this.cpu.data[SPMCSR] = this.cpu.data[SPMCSR]! | (1 << SELFPRGEN);
      this.cpu.setInstructionBarrier(this.fetchBlocked);
      if (snap?.pendingRemainingMs !== undefined) this.programming.start(snap.pendingRemainingMs);
      else this.programming.startCycles(snap?.pendingRemainingCycles || SPM_COMMAND_CYCLES);
    }
    if ((this.cpu.data[SPMCSR]! & (1 << SELFPRGEN)) !== 0 && this.pendingOperation === null) {
      this.cpu.addClockEvent(this.clearCommandEvent, snap?.commandClearRemainingCycles || SPM_COMMAND_CYCLES);
    }
    if ((this.cpu.data[SPMCSR]! & (1 << RWWSB)) !== 0) this.cpu.setInstructionBarrier(this.fetchBlocked);
    this.updateInterrupt();
  }

  private executeSpm(pc: number): void {
    const control = this.cpu.data[SPMCSR]!;
    this.cpu.clearClockEvent(this.clearCommandEvent);
    if (this.pendingOperation !== null) return;
    if ((control & (1 << SELFPRGEN)) === 0) return;
    if ((this.cpu.data[EECR]! & (1 << EEPE)) !== 0) { this.clearCommandBits(); return; }
    if (!this.isBootSection(pc)) {
      this.clearCommandBits();
      return;
    }

    const z = this.zPointer();
    if ((control & (1 << PGERS)) !== 0) {
      if (!this.spmAllowed(z)) {
        this.clearCommandBits();
        return;
      }
      this.scheduleOperation({ kind: "erase", pageBase: this.pageBase(z), lockValue: 0xff });
    } else if ((control & (1 << PGWRT)) !== 0) {
      if (!this.spmAllowed(z)) {
        this.clearCommandBits();
        return;
      }
      this.scheduleOperation({ kind: "write", pageBase: this.pageBase(z), lockValue: 0xff });
    } else if ((control & (1 << RWWSRE)) !== 0) {
      this.scheduleOperation({ kind: "rww", pageBase: 0, lockValue: 0xff });
    } else if ((control & (1 << BLBSET)) !== 0) {
      this.scheduleOperation({ kind: "lock", pageBase: 0, lockValue: this.cpu.data[0]! });
    } else {
      this.fillPageBuffer(z);
      this.clearCommandBits();
    }
  }

  private readSpecialProgramByte(byteAddr: number, readerPc: number): number | undefined {
    const control = this.cpu.data[SPMCSR]!;
    if ((control & (1 << SELFPRGEN)) !== 0) {
      if ((control & (1 << BLBSET)) !== 0) {
        const fuses = this.fuses();
        switch (byteAddr & 0xffff) {
          case 0x0000:
            return fuses.low;
          case 0x0001:
            return fuses.lockBits;
          case 0x0002:
            return fuses.extended;
          case 0x0003:
            return fuses.high;
          default:
            return 0;
        }
      }
      if ((control & (1 << SIGRD)) !== 0) {
        switch (byteAddr & 0xffff) {
          case 0x0000:
            return 0x1e;
          case 0x0002:
            return 0x95;
          case 0x0004:
            return 0x0f;
          default:
            return 0;
        }
      }
    }
    if ((byteAddr >> 1) < NRWW_START_WORD && (this.cpu.data[SPMCSR]! & (1 << RWWSB)) !== 0) return 0;
    if (this.lpmBlocked(byteAddr, readerPc)) return 0;
    return undefined;
  }

  private spmAllowed(byteAddr: number): boolean {
    const targetBoot = this.isBootSection(byteAddr >> 1);
    const lockBits = this.fuses().lockBits;
    return targetBoot ? !this.lockProgrammed(lockBits, BLB11) : !this.lockProgrammed(lockBits, BLB01);
  }

  private lpmBlocked(byteAddr: number, readerPc: number): boolean {
    const targetBoot = this.isBootSection(byteAddr >> 1);
    const readerBoot = this.isBootSection(readerPc);
    if (targetBoot === readerBoot) return false;
    const lockBits = this.fuses().lockBits;
    if (targetBoot) return this.lockProgrammed(lockBits, BLB12);
    return this.lockProgrammed(lockBits, BLB02);
  }

  private lockProgrammed(lockBits: number, bit: number): boolean {
    return (lockBits & (1 << bit)) === 0;
  }

  private scheduleOperation(operation: PendingSpmOperation): void {
    if (operation.kind === "rww") {
      this.pageBuffer.fill(0xffff);
      this.cpu.data[SPMCSR] = this.cpu.data[SPMCSR]! & ~(1 << RWWSB);
      this.cpu.setInstructionBarrier(undefined);
      this.clearCommandBits();
      return;
    }
    this.pendingOperation = operation;
    this.pendingPageData = operation.kind === "write" ? this.pageBuffer.slice() : undefined;
    if (operation.kind === "erase" || operation.kind === "write") this.markRwwBusy(operation.pageBase);
    this.cpu.setInstructionBarrier(this.fetchBlocked);
    this.updateInterrupt();
    if (operation.kind === "lock") this.programming.startCycles(SPM_COMMAND_CYCLES);
    else this.programming.start(FLASH_PROGRAMMING_MS);
  }

  private completePendingOperation(): void {
    const operation = this.pendingOperation;
    this.pendingOperation = null;
    if (operation === null) return;

    switch (operation.kind) {
      case "erase":
        this.erasePage(operation.pageBase);
        break;
      case "write":
        this.writePage(operation.pageBase);
        break;
      case "lock":
        this.setLockBits(this.fuses().lockBits & operation.lockValue);
        break;
      case "rww":
        this.cpu.data[SPMCSR] = this.cpu.data[SPMCSR]! & ~(1 << RWWSB);
        break;
    }

    this.pendingPageData = undefined;
    if ((this.cpu.data[SPMCSR]! & (1 << RWWSB)) === 0) this.cpu.setInstructionBarrier(undefined);
    this.clearCommandBits();
  }

  private fillPageBuffer(byteAddr: number): void {
    const wordOffset = (byteAddr >> 1) & PAGE_MASK;
    this.pageBuffer[wordOffset] = this.cpu.data[0]! | (this.cpu.data[1]! << 8);
  }

  private erasePage(pageBase: number): void {
    for (let i = 0; i < PAGE_WORDS; i += 1) {
      const word = pageBase + i;
      if (word < FLASH_WORDS) this.cpu.flash[word] = 0xffff;
    }
    this.cpu.invalidateDecodeCache();
  }

  private writePage(pageBase: number): void {
    for (let i = 0; i < PAGE_WORDS; i += 1) {
      const word = pageBase + i;
      if (word < FLASH_WORDS) this.cpu.flash[word] = this.cpu.flash[word]! & (this.pendingPageData ?? this.pageBuffer)[i]!;
    }
    this.pageBuffer.fill(0xffff);
    this.cpu.invalidateDecodeCache();
  }

  private markRwwBusy(pageBase: number): void {
    if (pageBase < NRWW_START_WORD) {
      this.cpu.data[SPMCSR] = this.cpu.data[SPMCSR]! | (1 << RWWSB);
    }
  }

  private clearCommandBits(): void {
    this.cpu.data[SPMCSR] = this.cpu.data[SPMCSR]! & ~COMMAND_MASK;
    this.cpu.clearClockEvent(this.clearCommandEvent);
    this.updateInterrupt();
  }

  private zPointer(): number {
    return this.cpu.data[30]! | (this.cpu.data[31]! << 8);
  }

  private pageBase(byteAddr: number): number {
    return (byteAddr >> 1) & ~PAGE_MASK;
  }

  private isBootSection(pc: number): boolean {
    return pc >= this.bootStartWord() && pc < FLASH_WORDS;
  }
}
