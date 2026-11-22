import type { AnalyticsMetric } from '../analytics.js';

export const operationsQuestions = [
  { key: 'LEADS_TODAY', metric: 'ALL', today: true,
    ar: 'كم فرصة وصلت اليوم؟', fr: "Combien de prospects sont arrivés aujourd’hui ?", en: 'How many leads arrived today?' },
  { key: 'AI_CONTACTED', metric: 'AI_CONTACTED', today: false,
    ar: 'كم فرصة تواصل معها الذكاء الاصطناعي؟', fr: 'Combien de prospects ont été contactés par l’IA ?', en: 'How many leads did AI contact?' },
  { key: 'NO_REPLY', metric: 'NO_CUSTOMER_RESPONSE', today: false,
    ar: 'كم فرصة لم ترد بعد التواصل؟', fr: 'Combien de prospects contactés sont sans réponse ?', en: 'How many contacted leads have not replied?' },
  { key: 'NO_FOLLOW_UP', metric: 'NO_FOLLOW_UP', today: false,
    ar: 'ما الفرص التي ليس لها متابعة مفتوحة؟', fr: 'Quels prospects sont sans suivi ouvert ?', en: 'Which leads have no open follow-up?' },
  { key: 'OVERDUE', metric: 'OVERDUE_FOLLOW_UP', today: false,
    ar: 'ما الفرص التي تأخرت متابعتها؟', fr: 'Quels prospects ont un suivi en retard ?', en: 'Which leads have overdue follow-ups?' },
  { key: 'ATTENTION', metric: 'ATTENTION', today: false,
    ar: 'ما الفرص التي تحتاج إلى انتباه؟', fr: 'Quels prospects nécessitent une attention ?', en: 'Which leads need attention?' },
  { key: 'CAMPAIGN_PERFORMANCE', metric: 'ALL', today: false,
    ar: 'لخص أداء الحملة', fr: 'Résume les performances de la campagne', en: 'Summarize campaign performance' },
] as const satisfies ReadonlyArray<{ key: string; metric: AnalyticsMetric; today: boolean; ar: string; fr: string; en: string }>;

const normalize = (question: string) => question.normalize('NFKD').toLowerCase().replace(/[\p{M}\u0640]/gu,'')
  .replace(/\p{P}/gu,' ').replace(/\s+/g,' ').trim();

const questionsByText = new Map(operationsQuestions.flatMap(question =>
  [question.ar,question.fr,question.en].map(text => [normalize(text),question] as const)));

export function findOperationsQuestion(question: string) {
  return questionsByText.get(normalize(question));
}
