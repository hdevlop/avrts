# Calibration and retained scope - 2026-10-10

Historical scope before the user selected the remaining digital extensions.
The deferred software models below have since been implemented; see
[current contracts](../wire-models.md) and the expanded root-plan queue.
Physical calibration remains unrun.

The selected scope is digital instruction/peripheral correctness, all current
workload results, EEPROM/flash programming intervals and logical T0/T1 input.
The standard [ATmega328P datasheet DS40002061B](https://ww1.microchip.com/downloads/en/DeviceDoc/ATmega48A-PA-88A-PA-168A-PA-328-P-DS-DS40002061B.pdf) is normative;
register/vector inventory and native agreement alone do not establish hardware
fidelity. No physical hardware was measured.

| Area | Decision and evidence |
| --- | --- |
| Timer1 fast PWM | TOP policy retained from the mode description. The compiled `timer1-top` probe observes counter 1000 in both avrts modes and zero in native simavr. Raw discrepancy is preserved, with no flag normalization. |
| Timer2 async | Existing transfer/phase/RTC, three CPU-clock flag synchronization, timer-stage wake and pre-sleep read policy retained. Full focused source tests and the native drift probe are release gates. Clear/ack crossing, repeat-sleep handshake within one TOSC period and PSRASY latency are deferred because the native reset probe does not supply a trustworthy reference and no hardware capture exists. |
| External TOSC/EXCLK | Deferred. The current API models a fixed logical 32.768 kHz source. A source-switch/phase and pending-transfer contract needs a concrete caller; introducing an unrequested electrical pin clock would expand the public API. |
| EXTI/PCINT | Existing sleep masking, held-level wake and synchronized digital sampling retained; focused tests cover startup ordering. Fractional short pulses and oscillator-startup retention remain uncalibrated. |
| Comparator | ACME/PRADC delivery and ACIC capture ordering remain tested. Propagation, power-up settling and voltage-dependent effects require measurements; logical voltage comparisons are the selected contract. |
| Clock/wake | CKDIV8, explicit SUT/CKSEL cycle approximation, WDT/BOD handshake and existing wake-entry order retained. New pending programming tests cover CLKPR, PRR, deep sleep, powered reset/startup and restore. Physical oscillator drift/startup is deferred. |
| Reserved timer modes | Retain documented MAX free-running behavior for Timer1 mode 13 and Timer0/2 modes 4/6. Reserved modes supply no silicon guarantee to reproduce. |
| USART | Retain byte-frame host injection, FIFO/error/MPCM support. GPIO XCK and bit-sampled RX/error derivation are deferred until a wire client is selected. |
| SPI | Retain byte transfers, DORD metadata, SS faults, SPIF/WCOL acknowledgement semantics and existing injected slave interface. Complete serial pin ownership is deferred. |
| TWI | Retain the shared host byte-operation contract and existing START/STOP timing. Physical multi-master arbitration and per-bit asleep stretching require a logical bus/driver contract and are deferred. |
| GPIO | Existing effective logical pin ownership retained; no new electrical contention or floating-voltage solver. External timer inputs reuse this contract. |
| OSCCAL/DIDR | Retain storage/mask-only behavior; no oscillator calibration or electrical buffer suppression is claimed. |
| Permanent exclusions | debugWIRE, electrical noise/leakage/current, VCC/temperature dependent programming, wear and physical supply-loss corruption remain excluded. |

The runtime probe [raw capture](runtime-fidelity-2026-10-10.json) identifies
functional bytes, independent avrts timing expectations and native differences.
Native simavr supplies functional programming agreement and external counts;
it does not calibrate the new EEPROM/flash busy duration or physical T0/T1 delay.
Phase-correct PWM's unavailable native GPIO traces remain explicit; both JS
engines still verify actual waveforms.

These decisions close scope selection. They do not implement the deferred
features or promise a simulator free of unknown bugs. Further physical/wire
work requires a separately selected contract and evidence.
