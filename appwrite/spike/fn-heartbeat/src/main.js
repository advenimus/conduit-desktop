import { Client, TablesDB, Query } from 'node-appwrite';
export default async ({ req, res }) => {
  const userId = req.headers['x-appwrite-user-id'];
  if (!userId) return res.json({ error: 'not_authenticated', code: '28000' }, 401);
  const client = new Client().setEndpoint(process.env.CONDUIT_API_ENDPOINT ?? process.env.APPWRITE_FUNCTION_API_ENDPOINT).setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID).setKey(req.headers['x-appwrite-key']);
  const db = new TablesDB(client);
  const t0 = Date.now();
  const rows = await db.listRows({ databaseId: 'spike', tableId: 'leases', queries: [Query.equal('user_id', [userId]), Query.limit(5)] });
  return res.json({ ok: true, userId, rows: rows.total, dbMs: Date.now() - t0 });
};
