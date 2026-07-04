#include <Arduino.h>
#include <EEPROM.h>

// Arduino EEPROM library validation fixture. EEPROM.write/read/update/put drive
// the EECR/EEDR/EEAR register protocol and busy-wait on EEPE, so each byte takes
// real simulated time to commit. This sketch stores a small record, reads it
// back through EEPROM.read (and EEPROM.get for a 16-bit value), and publishes the
// read-back bytes to SRAM 0x0300 so a host test can confirm both the SRAM copy
// and the persisted EEPROM contents. Result block:
// [marker, r[0], r[1], r[2], getLo, getHi, marker].

#define RESULT ((volatile uint8_t*)0x0300)

void setup() {
  for (uint8_t i = 0; i < 8; i++) RESULT[i] = 0;

  // Persist a short record at the start of EEPROM.
  EEPROM.write(0, 0xa5);
  EEPROM.write(1, 0x3c);
  EEPROM.update(2, 0x7e); // update only writes when the byte differs.
  uint16_t magic = 0xbeef;
  EEPROM.put(4, magic); // 16-bit little-endian store across cells 4..5.

  // Read the record back through the library.
  uint8_t r0 = EEPROM.read(0);
  uint8_t r1 = EEPROM.read(1);
  uint8_t r2 = EEPROM.read(2);
  uint16_t got = 0;
  EEPROM.get(4, got);

  RESULT[0] = 0xa7;
  RESULT[1] = r0;
  RESULT[2] = r1;
  RESULT[3] = r2;
  RESULT[4] = got & 0xff;
  RESULT[5] = (got >> 8) & 0xff;
  RESULT[6] = 0x5c;
}

void loop() {
}
