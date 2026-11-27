/**
 * RFC 8785 compliant JSON Canonicalization Scheme (JCS) implementation.
 */
export function canonicalize(obj: any): string {
  if (obj === null) {
    return "null";
  }
  if (typeof obj === "boolean") {
    return obj ? "true" : "false";
  }
  if (typeof obj === "number") {
    if (!Number.isFinite(obj)) {
      throw new Error("JCS does not support Infinity or NaN");
    }
    if (Object.is(obj, -0)) {
      return "0";
    }
    return obj.toString();
  }
  if (typeof obj === "string") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    const items = obj.map((item) => canonicalize(item));
    return "[" + items.join(",") + "]";
  }
  if (typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    const parts = keys
      .filter((key) => obj[key] !== undefined)
      .map((key) => {
        return canonicalize(key) + ":" + canonicalize(obj[key]);
      });
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`Unsupported type: ${typeof obj}`);
}
