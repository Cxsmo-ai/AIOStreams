/**
 * Comparators joining operands inside one expression:
 * `{a::exists::and::b::exists["yes"||"no"]}`.
 *
 * `left` and `right` look odd but are the documented way to discard one side of
 * a comparison, so they stay.
 */
export const comparatorFunctions: Record<string, (a: any, b: any) => unknown> =
  {
    and: (a, b) => a && b,
    or: (a, b) => a || b,
    xor: (a, b) => (a || b) && !(a && b),
    neq: (a, b) => a !== b,
    equal: (a, b) => a === b,
    left: (a) => a,
    right: (_, b) => b,
  };

export const comparatorNames: readonly string[] =
  Object.keys(comparatorFunctions);
