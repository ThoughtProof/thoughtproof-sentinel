import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendDocsHtml, swaggerUiHtml } from '../src/openapi-docs.js';

export default function handler(req: VercelRequest, res: VercelResponse) {
  sendDocsHtml(req, res, swaggerUiHtml());
}
