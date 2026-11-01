import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import { env } from '../config.js';

let client: Anthropic | undefined;

/** JOBAPPLYAI_OFFLINE=1 (set by the test runner) keeps everything on the rule-based path. */
export const hasClaude = () => env.anthropicKey !== '' && !process.env.JOBAPPLYAI_OFFLINE;

function getClient(): Anthropic {
  client ??= new Anthropic({ apiKey: env.anthropicKey, maxRetries: 4 });
  return client;
}

export class ClaudeRefusalError extends Error {}

export interface StructuredRequest {
  /** Stable instructions plus the candidate profile; cached across calls. */
  system: string;
  user: string;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
}

/**
 * One Claude call that must return JSON matching `schema`.
 * Uses server-side fallbacks so a policy decline is retried on another model.
 */
export async function askStructured<S extends z.ZodType>(schema: S, req: StructuredRequest): Promise<z.infer<S>> {
  const response = await getClient().beta.messages.parse({
    model: env.claudeModel,
    max_tokens: req.maxTokens ?? 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: req.user }],
    output_config: { effort: req.effort ?? 'medium', format: betaZodOutputFormat(schema) },
  });

  if (response.stop_reason === 'refusal') {
    throw new ClaudeRefusalError(`Claude declined: ${response.stop_details?.explanation ?? 'no explanation'}`);
  }
  if (response.stop_reason === 'max_tokens') throw new Error('Claude response was cut off (max_tokens)');
  if (response.parsed_output == null) throw new Error('Claude returned output that did not match the schema');
  return response.parsed_output as z.infer<S>;
}

export { Anthropic };
