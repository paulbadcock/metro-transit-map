/* ─── Basemap style null-number guard ─────────────────────────────────────
 * OpenFreeMap's "Liberty" style compares some tile feature properties
 * against numbers without checking they exist first -- e.g. the highway
 * shield layers filter on ["<=", ["get", "ref_length"], 6], but every
 * transportation_name feature for a street with no route number has no
 * ref_length at all. MapLibre evaluates that as a number assertion on null,
 * which fails, and logs "Expected value to be of type number, but found
 * null instead." from its tile worker once per offending feature -- the
 * console flood seen on every pan/zoom. The feature is still (correctly)
 * filtered out; the warning is pure noise.
 *
 * guardNullNumbers() rewrites the fetched style before it reaches MapLibre:
 *   - filter comparisons [op, ["get", p], <number>] (op one of < <= > >=)
 *     become ["all", ["==", ["typeof", ["get", p]], "number"], original],
 *     the same guard the style already uses on boundary_3. "all"
 *     short-circuits, so a missing property just yields false (exactly
 *     what the failed assertion already resolved to) without the warning.
 *   - a bare ["get", p] used as a numeric paint value (fill-extrusion
 *     height/base) becomes ["coalesce", ["get", p], 0].
 *
 * UMD like next-buses.js: a classic script in the browser (sets
 * window.BasemapStyle) and require()-able from node:test.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.BasemapStyle = factory();
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  const NUMERIC_COMPARISONS = new Set(["<", "<=", ">", ">="]);
  const NUMERIC_PAINT_PROPS = ["fill-extrusion-height", "fill-extrusion-base"];

  function isGet(expr) {
    return Array.isArray(expr) && expr[0] === "get" && expr.length === 2 && typeof expr[1] === "string";
  }

  function guardFilter(expr) {
    if (!Array.isArray(expr)) return expr;
    const [op, a, b] = expr;
    if (NUMERIC_COMPARISONS.has(op) && expr.length === 3) {
      const getExpr = isGet(a) && typeof b === "number" ? a : isGet(b) && typeof a === "number" ? b : null;
      if (getExpr) return ["all", ["==", ["typeof", getExpr], "number"], expr];
    }
    // Recurse into sub-expressions (all/any/case/match arguments, etc.).
    // Literal arrays inside ["literal", ...] are data, not expressions.
    if (op === "literal") return expr;
    return expr.map((sub) => guardFilter(sub));
  }

  function guardNullNumbers(style) {
    for (const layer of style.layers || []) {
      if (layer.filter) layer.filter = guardFilter(layer.filter);
      for (const prop of NUMERIC_PAINT_PROPS) {
        const value = layer.paint?.[prop];
        if (isGet(value)) layer.paint[prop] = ["coalesce", value, 0];
      }
    }
    return style;
  }

  return { guardNullNumbers };
});
