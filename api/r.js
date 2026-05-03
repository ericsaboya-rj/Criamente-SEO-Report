var kv = require('@vercel/kv');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Pega o ID da query string: /api/r?id=abc123
  var id = (req.query && req.query.id) || '';
  if (!id) return res.status(400).json({ error: 'ID nao fornecido' });

  try {
    var report = await kv.get('report:' + id);
    if (!report) return res.status(404).json({ error: 'Relatorio nao encontrado ou expirado' });
    return res.status(200).json({ success: true, report: report });
  } catch(err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
