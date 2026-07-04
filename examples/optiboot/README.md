# Optiboot Fixture

Stock Arduino AVR core Optiboot image for ATmega328P / Arduino Uno.

Source package:
`arduino:avr@1.8.8`, `bootloaders/optiboot/optiboot_atmega328.hex`.

`test/phase6-optiboot.test.ts` loads this boot section image with Uno-style
BOOTRST/BOOTSZ fuses, speaks STK500v1 over `avr.serial`, flashes a small sketch,
and verifies the uploaded app runs after Optiboot leaves programming mode.
