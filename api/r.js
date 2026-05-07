// Upstash Redis via REST API — sem dependencia de pacote
var KV = {
  _url: function() { return process.env.KV_REST_API_URL; },
  _token: function() { return process.env.KV_REST_API_TOKEN; },
  get: async function(key) {
    var r = await fetch(this._url() + '/get/' + encodeURIComponent(key), {
      headers: { Authorization: 'Bearer ' + this._token() }
    });
    var d = await r.json();
    return d.result || null;
  },
  set: async function(key, value, opts) {
    var body = ['SET', key, typeof value === 'string' ? value : JSON.stringify(value)];
    if (opts && opts.ex) body.push('EX', opts.ex);
    var r = await fetch(this._url(), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this._token(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return r.json();
  },
  del: async function(key) {
    var r = await fetch(this._url(), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this._token(), 'Content-Type': 'application/json' },
      body: JSON.stringify(['DEL', key])
    });
    return r.json();
  }
};
var kv = KV;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Pega o ID da query string: /api/r?id=abc123
  var id = (req.query && req.query.id) || '';
  if (!id) return res.status(400).json({ error: 'ID nao fornecido' });

  try {
    var raw = await kv.get('report:' + id);
    if (!raw) return res.status(404).json({ error: 'Relatorio nao encontrado ou expirado' });
    // Upstash REST retorna string — faz parse se necessario
    var report = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return res.status(200).json({ success: true, report: report });
  } catch(err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
