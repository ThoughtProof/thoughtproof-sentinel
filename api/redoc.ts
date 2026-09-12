import type { VercelRequest, VercelResponse } from '@vercel/node';
import { redocHtml, sendDocsHtml } from '../src/openapi-docs.js';

export default function handler(req: VercelRequest, res: VercelResponse) {
  sendDocsHtml(req, res, redocHtml());
}
