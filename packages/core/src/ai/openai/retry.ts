/**
 * Compatibility entrypoint for the host-neutral OpenAI retry policy.
 *
 * Provider transport is owned by @kode/ai; core retains this path for
 * existing callers while avoiding a second implementation that can drift.
 */
export * from '@kode/ai/openai/retry'
