/**
 * The React form hook, re-exported from `ai-forms/react`.
 *
 * Kept on its own subpath so importing `ai-kit` on a server never pulls React
 * in. `react` is an OPTIONAL peer for exactly this reason: an app using only
 * the provider chain should not be asked to install a UI library.
 */
export * from "ai-forms/react";
