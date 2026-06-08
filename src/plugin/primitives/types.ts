/**
 * Shared types for the plugin primitives.
 *
 * @module primitives/types
 */

import type { createOpencodeClient } from "@opencode-ai/sdk"

/**
 * OpenCode client instance type.
 * Derived from the factory function return type for type safety.
 */
export type OpencodeClient = ReturnType<typeof createOpencodeClient>
