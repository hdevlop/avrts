/** Thrown when source compilation fails or the required toolchain is missing. */
export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
}
