"use strict";
/**
 * The model REGISTRY — one SSOT for every model id an app may call.
 *
 * This module exists because the fleet paid for its absence twice, in two
 * different currencies:
 *
 *   OUTAGE — on 2026-08-18 Groq removed `llama-3.3-70b-versatile` and one app
 *   kept asking for it for eight days. A rot checker already existed, but it
 *   probed only the chains it knew about; the id that died was pinned
 *   elsewhere. A checker that does not enumerate its subjects cannot report
 *   the one it never knew about. The registry IS the enumeration: a model id
 *   is callable only if it appears here, and the catalog check walks exactly
 *   this list.
 *
 *   MONEY — three apps silently billed real money on fallback, because the
 *   only thing separating the free variant from the paid one was a `:free`
 *   suffix on the id string. A billing boundary that lives in a naming
 *   convention is one typo away from a paid call. Here it is a FIELD, and the
 *   validator refuses an entry whose flag contradicts its own cost or suffix —
 *   so the contradiction is a build failure, not an invoice.
 *
 * What deliberately does NOT live here: which model to PREFER (that is the
 * chain's job), UI presentation (labels, badges — app concern), and anything
 * that knows where data lives. Same boundary as the rest of this package:
 * meaning in core, adapters in the app.
 *
 * ── Vendor vs author ─────────────────────────────────────────────────────────
 * A registry row is a CALLABLE id at a VENDOR — the place a request goes —
 * because that is the unit that rots, meters, and bills. The AUTHOR (who
 * trained it) is metadata. The two were conflated in one app's registry
 * ("provider: Anthropic" on a row served by OpenRouter), which made "who do we
 * pay" unanswerable by query. Here they are separate fields.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.defineRegistry = defineRegistry;
exports.freeOnly = freeOnly;
exports.toolCapable = toolCapable;
/** A `:free`-suffixed id claiming to be paid, or a "free" entry with a price —
 *  each one is the 2026 billing incident waiting to recur. */
function validateEntry(e) {
    if (!e.id.trim())
        return "entry has an empty id";
    if (!e.vendor.trim())
        return `"${e.id}": empty vendor`;
    const cost = (e.inputCostPer1M ?? 0) + (e.outputCostPer1M ?? 0);
    if (!e.paid && cost > 0) {
        return `"${e.id}": declared free but carries a cost (${cost}/1M) — the flag or the price is lying`;
    }
    if (e.paid && e.id.endsWith(":free")) {
        return `"${e.id}": declared paid but the id says :free — the flag or the id is lying`;
    }
    return null;
}
/**
 * Build a registry from entries. Throws on the first contradiction — a
 * registry that loads is a registry whose billing boundary can be trusted.
 */
function defineRegistry(entries) {
    const seen = new Set();
    for (const e of entries) {
        const problem = validateEntry(e);
        if (problem)
            throw new Error(`ai-kit registry: ${problem}`);
        const key = `${e.vendor}:${e.id}`;
        if (seen.has(key)) {
            throw new Error(`ai-kit registry: duplicate entry ${key} — two rows for one callable id is two sources of truth`);
        }
        seen.add(key);
    }
    const frozen = Object.freeze(entries.map((e) => ({ ...e })));
    const find = (id, vendor) => frozen.find((e) => e.id === id && (vendor === undefined || e.vendor === vendor));
    return {
        entries: frozen,
        find,
        require(id, vendor) {
            const hit = find(id, vendor);
            if (!hit) {
                const scope = vendor ? ` at ${vendor}` : "";
                throw new Error(`ai-kit registry: "${id}"${scope} is not registered — a model id is callable only if it appears in the registry (add it with its paid flag, or stop calling it)`);
            }
            return hit;
        },
        idsForVendor: (vendor) => frozen.filter((e) => e.vendor === vendor).map((e) => e.id),
        vendors: () => [...new Set(frozen.map((e) => e.vendor))],
        freeEntries: () => frozen.filter((e) => !e.paid),
        paidEntries: () => frozen.filter((e) => e.paid),
    };
}
/**
 * The platform-key guard: the ids from `requested` that a platform-funded
 * call may serve. Registered-and-free passes; paid is dropped; an UNKNOWN id
 * is dropped too — an id nobody registered has an unknown price, and "unknown"
 * spends someone's money only when a person decides it does.
 *
 * Returns the dropped ids alongside, because a silently narrowed chain reads
 * as "covered everything" when it didn't.
 */
function freeOnly(registry, requested) {
    const allowed = [];
    const dropped = [];
    for (const id of requested) {
        const entry = registry.find(id);
        if (!entry)
            dropped.push({ id, why: "unregistered" });
        else if (entry.paid)
            dropped.push({ id, why: "paid" });
        else
            allowed.push(id);
    }
    return { allowed, dropped };
}
/**
 * A tool-driving chain may only contain models that can drive a tool loop.
 * "unprobed" entries are reported, not silently trusted — the probe table is
 * one `npm run probe:models` away, and a chain built on guesses loses turns
 * exactly on the models most likely to serve free traffic.
 */
function toolCapable(registry, requested) {
    const usable = [];
    const refused = [];
    for (const id of requested) {
        const entry = registry.find(id);
        const protocol = entry?.toolProtocol ?? "unprobed";
        if (protocol === "native" || protocol === "text")
            usable.push(id);
        else
            refused.push({ id, protocol });
    }
    return { usable, refused };
}
