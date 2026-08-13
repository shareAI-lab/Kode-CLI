/**
 * Compatibility entrypoint for the host-neutral custom-model discovery API.
 *
 * Keep the historical core path stable while @kode/ai remains the only
 * implementation of URL normalization and response validation.
 */
export * from '@kode/ai/openai/customModels'
