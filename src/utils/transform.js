/**
 * Registry of named string transforms.
 * Each entry maps a transform name to a function that takes (value, arg).
 * @type {Record<string, (value: string, arg?: string) => string>}
 */
const TRANSFORMS = {
  uppercase: (v) => v.toUpperCase(),
  lowercase: (v) => v.toLowerCase(),
  capitalize: (v) => v.replace(/\b\w/g, (c) => c.toUpperCase()),
  truncate: (v, n) => (v.length > Number(n) ? v.slice(0, Number(n)) + '…' : v),
};

/**
 * Apply a named transform to a value using a colon-delimited spec string.
 * @param {string} value - The raw value to transform.
 * @param {string} spec - Transform spec, e.g. `"uppercase"` or `"truncate:50"`.
 * @returns {string} The transformed string, or the original if the transform is unknown.
 */
export function transform(value, spec) {
  const [name, ...rest] = spec.split(':');
  const arg = rest.join(':');
  const fn = TRANSFORMS[name];
  return fn ? fn(String(value), arg) : String(value);
}
