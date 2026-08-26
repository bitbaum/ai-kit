/**
 * Form filling, re-exported from `ai-forms`.
 *
 * `ai-forms` is NOT absorbed. It stays its own package: it works, four apps run
 * it, and it is a genuinely general-purpose thing that people outside this fleet
 * can use. Swallowing it would break four repos and delete a good name off the
 * registry to satisfy a filing system.
 *
 * What this subpath buys is that an app adding AI installs ONE thing. AOZ is
 * the argument: it adopted `ai-forms`, then hand-rolled a provider layer and a
 * chat loop, because those were two further decisions nobody made. Filling a
 * form from prose and choosing which model fills it are the same feature to the
 * app, so they should be one install.
 */
export * from "ai-forms";
