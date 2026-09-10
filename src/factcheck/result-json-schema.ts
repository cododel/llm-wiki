import { resultSchema } from './protocol.ts';
const { zodToJsonSchema } = await import('zod-to-json-schema');
export const resultJsonSchema = zodToJsonSchema(resultSchema, { name: 'wiki-evidence-result-v1', $refStrategy:'none' });
