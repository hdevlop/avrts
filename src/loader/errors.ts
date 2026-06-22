/** Thrown when Intel HEX text is malformed, fails its checksum, or overflows flash. */
export class IntelHexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntelHexError";
  }
}
