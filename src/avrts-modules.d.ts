/**
 * Type declarations for non-TS assets imported by the browser demo (and any
 * future static-asset importers). Bun resolves these to string contents at
 * bundle time; the matching `import x from "*.hex" with { type: "text" }`
 * attribute is what tells Bun the literal type.
 */
declare module "*.hex" {
  const content: string;
  export default content;
}

declare module "*.css" {
  const content: string;
  export default content;
}
