import type postgres from 'postgres';
import { HttpError } from '../security.js';

export type BodyTemplateSnapshot = { externalTemplateId: string; name: string; language: string;
  category: string | null; components: [{ type: 'BODY'; text: string }];
  bodyParameters?: string[] };

export function bodyParameterCount(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024) return null;
  const references = [...value.matchAll(/\{\{([1-9]\d*)\}\}/g)];
  const remainder = value.replace(/\{\{[1-9]\d*\}\}/g, '');
  if (remainder.includes('{{') || remainder.includes('}}')) return null;
  if (!references.length) return 0;
  const numbers = references.map((match) => Number(match[1]));
  const max = Math.max(...numbers);
  if (max > 10 || max < 1 || numbers.some((number) => !Number.isInteger(number) || number < 1)
    || new Set(numbers).size !== max) return null;
  return max;
}

export async function approvedBodyTemplate(tx: postgres.TransactionSql,
  connectionId: string, campaignId: string, templateId: string,
  bodyParameters: string[] = []): Promise<{ body: string; snapshot: BodyTemplateSnapshot }> {
  const template = (await tx`SELECT external_template_id, name, language, category,
      status, active, components FROM provider_message_template
    WHERE id = ${templateId} AND connection_id = ${connectionId}
      AND EXISTS (SELECT 1 FROM campaign_message_template_binding b
        WHERE b.template_id = ${templateId} AND b.campaign_id = ${campaignId} AND b.active)
    FOR SHARE`)[0];
  if (!template) throw new HttpError(409, 'TEMPLATE_NOT_AVAILABLE');
  if (!template.active || template.status !== 'APPROVED') throw new HttpError(409, 'TEMPLATE_NOT_APPROVED');
  const components = template.components as unknown;
  if (!Array.isArray(components) || components.length !== 1 || !components[0]
    || typeof components[0] !== 'object' || components[0].type !== 'BODY')
    throw new HttpError(409, 'TEMPLATE_FORMAT_UNSUPPORTED');
  const rawBody = components[0].text as unknown;
  const count = bodyParameterCount(rawBody);
  if (count === null) throw new HttpError(409, 'TEMPLATE_FORMAT_UNSUPPORTED');
  if (!Array.isArray(bodyParameters) || bodyParameters.length !== count
    || bodyParameters.some((value) => typeof value !== 'string' || !value.trim()
      || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)))
    throw new HttpError(400, 'TEMPLATE_PARAMETERS_INVALID');
  const body = (rawBody as string).replace(/\{\{([1-9]\d*)\}\}/g,
    (_match, index: string) => bodyParameters[Number(index) - 1]!);
  if (body.length > 20000) throw new HttpError(400, 'TEMPLATE_PARAMETERS_INVALID');
  return { body, snapshot: { externalTemplateId: template.external_template_id,
    name: template.name, language: template.language, category: template.category,
    components: [{ type: 'BODY', text: rawBody as string }],
    ...(bodyParameters.length ? { bodyParameters } : {}) } };
}
