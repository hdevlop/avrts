# Float and bit-bang result-oracle evidence

Date: 2026-10-06. Baseline library revision: `859b7fef58ac5864618c01d484c6bcf64b077d89`.
Scope: the first implementation slice of [Phase 1](../../AVRTS-REMAINING-WORK-PLAN.md#5-phase-1--complete-benchmark-result-fidelity).

## Result coverage

Both result runners now include seven cases by default. The new
[`float-math`](../../examples/arduino-float-math/README.md) and
[`bitbang-crc`](../../examples/arduino-bitbang-crc/README.md) fixtures run
continuously unless SRAM `0x02ff=0x42` selects the 32-round result mode.
They write 21 bytes at `0x0300`, with the final `5c` marker written last.

The [captured JSON](arithmetic-results-2026-10-06.json) records five successful
three-engine scenarios, their commands, result blocks, selected registers,
output traces, normalizations and HEX digests. The new cases require no
normalization. Existing mixed-peripheral normalizations remain explicit.

| Scenario | Native simavr cycles | avr8js cycles | avrts runner cycles | Expected result |
| --- | ---: | ---: | ---: | --- |
| Float, 32 iterations | 189,903 | 189,925 | 190,009 | Result float bytes `03 82 80 41`; seed `70 c8 8e 3e` |
| Bit-bang, input `00` | 12,868 | 12,479 | 20,000 | CRC-8 `42`, CRC-16 `4f19`, last received `00` |
| Bit-bang, input `96` | 12,858 | 12,469 | 20,000 | CRC-8 `5f`, CRC-16 `4f19`, last received `96` |
| Bit-bang, input `a5` | 12,876 | 12,487 | 20,000 | CRC-8 `09`, CRC-16 `4f19`, last received `a5` |
| Bit-bang, input `ff` | 12,862 | 12,473 | 20,002 | CRC-8 `4b`, CRC-16 `4f19`, last received `ff` |

Cycle counts are observations of each runner reaching or observing completion.
avrts polls the result marker between bounded run chunks. They are not
throughput ratios, equality assertions, or physical timing calibration.

For bit-banging, each rising D13/PB5 edge drives the next MSB-first input bit on
D12/PB4 and samples D11/PB3. All engines observe 256 rising and 256 falling
edges, with this declared 32-byte MOSI sequence:

```text
31 43 51 67 71 83 91 af b1 c3 d1 e7 f1 03 11 2f
21 53 41 77 61 93 81 bf a1 d3 c1 f7 e1 13 01 3f
```

Peer agreement is paired with expected-output checks. Float bytes are a pinned
compiled AVR-libc golden agreed by both independent references, not a host
JavaScript math substitution. The bit-bang CRC-8 is specified in the host over
the declared byte sequence; CRC-16 has a pinned expected value, and transmitted
bytes and clock-edge counts are checked independently of result SRAM.

## Regression coverage and harness correction

`test/arithmetic-results.test.ts` adds 16 tests covering peer/golden agreement,
four input patterns, fast/cycle-exact continuous activity after warmup, stable
finite results, mid-calculation float snapshot/resume, absent/altered pin traces,
corrupt results, default CLI inclusion and invalid selections.

The result runner previously always requested a 10,000-cycle chunk even when
less budget remained. It could observe a completion beyond the requested limit.
It now caps each chunk to the remaining budget. A regression with an 11,000-cycle
limit requires both engines to remain incomplete and report a failure.

Focused result tests: 30 passed, zero failed, 195 assertions across the new test
file and the existing benchmark-result file. `bun run verify` passed TypeScript,
generated-core consistency, and all 2,759 source tests: zero failures,
17,825 assertions across 75 files in 293.93 seconds. Its log is retained at
ignored `logs/arithmetic-verify-2026-10-06.log`.

Native checks rerun successfully: all seven result cases, all five timing cases,
normalized core-state smoke, and Optiboot transcript/page/application acceptance.
The raw capture also checks all four bit-bang inputs. No emulator library source,
public API, package version or CI workflow changed. Browser/package acceptance
and publication were not rerun or attempted for this development-harness slice.

## Fixture build identity and regeneration

| Firmware | SHA-256 of recorded local HEX file bytes |
| --- | --- |
| Float | `354065ebf0c22637dbfc7dec87628cb486966f397134109f8fa67823ac973049` |
| Bit-bang | `aef17de98c927556b5d16fe6105448b2bae46d709cb961978718831b42e21253` |

Source, HEX and disassembly were regenerated together with installed Arduino
AVR 1.8.8 / AVR GCC 7.3.0 and cached Uno core objects because Arduino CLI was
unavailable. Normal regeneration remains `bun run fixtures:arduino` with a
working CLI and the Uno core installed. The file digests describe this local
capture; checkout newline conversion can change a text-file digest without
changing the loaded flash image. This local build used:

```powershell
$taskCompiler = "$env:LOCALAPPDATA/Arduino15/packages/arduino/tools/avr-gcc/7.3.0-atmel3.6.1-arduino7/bin"
$taskCore = "$env:LOCALAPPDATA/Arduino15/packages/arduino/hardware/avr/1.8.8"
$taskArchive = "$env:LOCALAPPDATA/arduino/cores/arduino_avr_uno_7390909ab62f32fb4dfca840d18bcd49/core.a"
foreach ($taskFixture in @('arduino-float-math', 'arduino-bitbang-crc')) {
  $taskDir = "examples/$taskFixture"
  New-Item -ItemType Directory -Force -Path "$taskDir/build" | Out-Null
  Copy-Item -LiteralPath "$taskDir/$taskFixture.ino" -Destination "$taskDir/build/$taskFixture.ino.cpp"
  & "$taskCompiler/avr-g++.exe" -c -g -Os -std=gnu++11 -fpermissive -fno-exceptions `
    -ffunction-sections -fdata-sections -fno-threadsafe-statics -Wno-error=narrowing -MMD -flto `
    -mmcu=atmega328p -DF_CPU=16000000L -DARDUINO=10607 -DARDUINO_AVR_UNO -DARDUINO_ARCH_AVR `
    "-I$taskCore/cores/arduino" "-I$taskCore/variants/standard" `
    "$taskDir/build/$taskFixture.ino.cpp" -o "$taskDir/build/$taskFixture.ino.cpp.o"
  if ($LASTEXITCODE -ne 0) { throw 'Fixture compile failed' }
  & "$taskCompiler/avr-gcc.exe" -Os -g -flto -fuse-linker-plugin '-Wl,--gc-sections' -mmcu=atmega328p `
    -o "$taskDir/build/$taskFixture.ino.elf" "$taskDir/build/$taskFixture.ino.cpp.o" $taskArchive -lm
  if ($LASTEXITCODE -ne 0) { throw 'Fixture link failed' }
  & "$taskCompiler/avr-objcopy.exe" -O ihex -R .eeprom `
    "$taskDir/build/$taskFixture.ino.elf" "$taskDir/$taskFixture.ino.hex"
  if ($LASTEXITCODE -ne 0) { throw 'HEX generation failed' }
  $taskListing = & "$taskCompiler/avr-objdump.exe" -d "$taskDir/build/$taskFixture.ino.elf"
  if ($LASTEXITCODE -ne 0) { throw 'Listing generation failed' }
  $taskText = (($taskListing | ForEach-Object { $_.TrimEnd() }) -join "`n") + "`n"
  [IO.File]::WriteAllText((Join-Path (Get-Location) "$taskDir/$taskFixture.lst"), $taskText, [Text.UTF8Encoding]::new($false))
}
```

The cached archive path is host-specific and must be replaced with a verified
Uno core archive on another machine. Tests consume the committed HEX and do not
require this compiler or cache. Review any changed golden bytes against the
reference engines instead of updating expectations merely to make tests pass.

These rebuilt images add a finite-mode branch. Normal mode is still active, but
older speed results used the preceding HEX files. No new speed ratio is claimed;
future comparisons must hold the candidate firmware constant across engines and
source revisions and retain its digest.

## Remaining Phase 1 work

Add `sensor-format`, `serial-print`, `analog-write`, `delay-blink`, and synthetic
`tight-loop` result/state/waveform checks, plus listener delivery assertions on
the shared serial fixture. The complete phase remains open in the root plan.
