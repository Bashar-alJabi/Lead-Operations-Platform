import type postgres from 'postgres';
import { HttpError } from '../security.js';

export type StaticTemplateSnapshot = { externalTemplateId: string; name: string; language: string;
  category: string | null; components: [{ type: 'BODY'; text: string }] };

export async function approvedStaticTemplate(tx: postgres.TransactionSql,
  connectionId: string, campaignId: string, templateId: string): Promise<{ body: string; snapshot: StaticTemplateSnapshot }> {
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
    || typeof components[0] !== 'object' || components[0].type !== 'BODY'
    || typeof components[0].text !== 'string' || !components[0].text.trim()
    || components[0].text.length > 1024 || /\{\{|\}\}/.test(components[0].text))
    throw new HttpError(409, 'TEMPLATE_FORMAT_UNSUPPORTED');
  return { body: components[0].text,
    snapshot: { externalTemplateId: template.external_template_id, name: template.name,
      language: template.language, category: template.category,
      components: [{ type: 'BODY', text: components[0].text }] } };
}
