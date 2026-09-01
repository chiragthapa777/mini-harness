/**
 * Stands in for `react-devtools-core` when bundling.
 *
 * Ink imports it so that `DEV=true` can attach React DevTools. Nothing in a
 * shipped CLI does that, and it is an optional dependency, so bundling it
 * would add megabytes for a code path that never runs. Marking it external
 * instead does not work either: the import is static, so a missing package
 * fails at startup rather than at use.
 */
export default {
  connectToDevTools() {},
};
