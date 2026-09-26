/**
 * A reader's own key must never touch the deployment's shared bookkeeping.
 *
 * `byokChain` links share their provider id with the deployment's own link to
 * the same vendor (`groq` is `groq`). These tests pin each place that id could
 * have leaked: capacity, the link cooldown, health, and quota readings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { byokChain } from "../dist/byok.js";
import {
  createHealthTracker,
  createLinkCooldown,
  dayCapacityTokens,
  healthFor,
  isOwnKeyLink,
  LinkFailure,
  readQuota,
  tryChain,
} from "../dist/index.js";

const own = byokChain({
  vendor: "groq",
  apiKey: "gsk_EXAMPLENOTREAL",
  model: "llama-3.3-70b-versatile",
});
const ownLink = own.chain[0];
const siteProvider = {
  id: "groq",
  baseUrl: "https://api.groq.com/openai/v1",
  keyEnv: "SITE_GROQ_KEY",
  models: ["llama-3.3-70b-versatile"],
  dailyTokens: 100_000,
};
const siteLink = { provider: siteProvider, model: "llama-3.3-70b-versatile" };

test("an own-key link is marked, and claims no tokens even if summed by hand", () => {
  assert.equal(isOwnKeyLink(ownLink), true);
  assert.equal(isOwnKeyLink(siteLink), false);
  assert.equal(ownLink.provider.dailyTokens, 0);
  assert.ok(
    Number.isFinite(ownLink.provider.dailyTokens),
    "Infinity would make any sum read as unlimited",
  );
});

test("capacity never counts a reader's key, even with a key and an override set", () => {
  const env = { SITE_GROQ_KEY: "x", BYOK_API_KEY: "y", OWN_DAILY: "999999" };
  const ownWithOverride = { ...ownLink.provider, dailyTokensEnv: "OWN_DAILY" };
  assert.equal(dayCapacityTokens([siteProvider, ownWithOverride], env), 100_000);
});

test("a reader's exhausted key does not cool the site's link with the same id", () => {
  const cooldown = createLinkCooldown({ now: () => 0 });
  cooldown.record(ownLink, new LinkFailure(ownLink, "429 daily", { status: 429, kind: "daily" }));
  assert.deepEqual(cooldown.cooling(), []);
  assert.deepEqual(cooldown.filter([siteLink]), [siteLink]);
  // …while the site's own refusal still does.
  cooldown.record(siteLink, new LinkFailure(siteLink, "429 daily", { status: 429, kind: "daily" }));
  assert.equal(cooldown.cooling().length, 1);
});

test("a reader's failing key leaves the site's health alone; the site's own failure does not", async () => {
  const health = createHealthTracker();
  const before = health.getHealth().status;
  await assert.rejects(
    tryChain(own.chain, {
      health,
      attempt: async () => {
        throw new Error("401");
      },
    }),
  );
  assert.equal(health.getHealth().status, before, "nothing was recorded");
  await assert.rejects(
    tryChain([siteLink], {
      health,
      attempt: async () => {
        throw new Error("500");
      },
    }),
  );
  assert.notEqual(health.getHealth().status, before, "the site's own failure is recorded");
});

test("healthFor drops the tracker only when every link is the reader's own", () => {
  const h = createHealthTracker();
  assert.equal(healthFor(own.chain, h), undefined);
  assert.equal(healthFor([siteLink], h), h);
  assert.equal(healthFor([ownLink, siteLink], h), h);
  assert.equal(healthFor([], h), h);
});

test("quota readings about a reader's key say so; the site's do not", () => {
  const headers = new Map([
    ["x-ratelimit-remaining-requests", "5"],
    ["x-ratelimit-limit-requests", "100"],
  ]);
  const bag = { get: (n) => headers.get(n) ?? null };
  const mine = readQuota(bag, ownLink);
  const site = readQuota(bag, siteLink);
  assert.ok(mine.length > 0 && mine.every((r) => r.byok === true));
  assert.ok(site.length > 0 && site.every((r) => r.byok === undefined));
});
