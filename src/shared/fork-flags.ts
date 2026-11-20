// Fork-only switches for upstream features this fork turns off. Each one is
// listed in docs/maintainers/fork/README.md and re-checked at every upstream
// sync.

/**
 * Upstream's "Move to Every App" sends this install's database to an Every
 * App install. This fork's schema differs from upstream's, so a move would
 * half-write to the target: the settings section is hidden and the server
 * functions refuse.
 */
export const MOVE_TO_EVERY_APP_ENABLED = false;
