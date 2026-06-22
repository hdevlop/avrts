/** Shared loader types. The Intel HEX parser arrives in Phase 4. */

/** Result of parsing a program image into flash. */
export interface HexLoadResult {
  /** Number of program bytes written into flash. */
  bytesLoaded: number;
  /** Highest byte address touched (useful for sanity checks). */
  maxByteAddress: number;
}
