export const INTEL_HEX_EOF = ":00000001FF";

export const DEFAULT_USART_FRAME_CYCLES = 176;
export const DEFAULT_SPI_TRANSFER_CYCLES = 32;
export const DEFAULT_TWI_SCL_CYCLES = 16;
export const DEFAULT_TWI_START_STOP_CYCLES = 1;
export const DEFAULT_TWI_BYTE_CYCLES = DEFAULT_TWI_SCL_CYCLES * 9;

/** Build an Intel HEX data record from 16-bit words in little-endian byte order. */
export function record(words: number[], address = 0): string {
  const bytes: number[] = [];
  for (const word of words) {
    bytes.push(word & 0xff);
    bytes.push((word >> 8) & 0xff);
  }
  const count = bytes.length;
  const body = [count, (address >> 8) & 0xff, address & 0xff, 0x00, ...bytes];
  let sum = 0;
  for (const byte of body) sum = (sum + byte) & 0xff;
  const checksum = (-sum) & 0xff;
  const hex = [...body, checksum].map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join("");
  return `:${hex}`;
}
