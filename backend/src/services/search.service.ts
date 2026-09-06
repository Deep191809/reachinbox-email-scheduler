import { Client } from '@elastic/elasticsearch';
import { env } from '../config/env.js';

export const elasticsearch = new Client({ node: env.ELASTICSEARCH_URL });
export const EMAIL_INDEX = 'emails';

export type EmailSearchDocument = {
  id: string;
  userId: string;
  campaignId: string;
  senderId: string;
  to: string;
  subject: string;
  body: string;
  status: string;
  scheduledAt: string;
  sentAt?: string;
};

export async function ensureEmailIndex() {
  const exists = await elasticsearch.indices.exists({ index: EMAIL_INDEX });
  if (!exists) {
    await elasticsearch.indices.create({
      index: EMAIL_INDEX,
      mappings: {
        properties: {
          id: { type: 'keyword' },
          userId: { type: 'keyword' },
          campaignId: { type: 'keyword' },
          senderId: { type: 'keyword' },
          to: { type: 'text', fields: { keyword: { type: 'keyword' } } },
          subject: { type: 'text' },
          body: { type: 'text' },
          status: { type: 'keyword' },
          scheduledAt: { type: 'date' },
          sentAt: { type: 'date' },
        },
      },
    });
  }
}

export async function indexEmail(document: EmailSearchDocument) {
  await elasticsearch.index({ index: EMAIL_INDEX, id: document.id, document });
}

export async function searchEmails(userId: string, query: string) {
  const response = await elasticsearch.search<EmailSearchDocument>({
    index: EMAIL_INDEX,
    query: {
      bool: {
        must: query.trim()
          ? [{ multi_match: { query, fields: ['to', 'subject', 'body'] } }]
          : [{ match_all: {} }],
        filter: [{ term: { userId } }],
      },
    },
    sort: [{ scheduledAt: { order: 'desc' } }],
    size: 100,
  });

  return response.hits.hits.flatMap((hit) => (hit._source ? [hit._source] : []));
}
