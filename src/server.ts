/**
 * The form-assist route factory, re-exported from `ai-forms/server`.
 *
 * This is the piece that explains the fleet's adoption numbers. `ai-forms` is
 * the most-adopted shared package here, and it is also the only one that ships
 * real machinery rather than decisions alone — AOZ imports this factory and the
 * React hook, and nothing else. A package that hands you a working route gets
 * installed; one that hands you advice about routes does not.
 */
export * from "ai-forms/server";
