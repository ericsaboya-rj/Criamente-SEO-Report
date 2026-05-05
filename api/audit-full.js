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

// ── HELPERS ──────────────────────────────────────────
function getRootUrl(url) {
  try { var p = new URL(url); return p.protocol + '//' + p.hostname; } catch(e) { return url; }
}

function generateId() {
  var c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  var id = '';
  for (var i = 0; i < 10; i++) id += c[Math.floor(Math.random() * c.length)];
  return id;
}

// ── FETCH COM TIMEOUT ─────────────────────────────────
async function fetchWithTimeout(url, ms) {
  ms = ms || 12000;
  var ctrl = new AbortController();
  var tid = setTimeout(function() { ctrl.abort(); }, ms);
  try {
    var r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache'
      }
    });
    clearTimeout(tid);
    return r;
  } catch(e) {
    clearTimeout(tid);
    throw e;
  }
}

// ── SITEMAP ───────────────────────────────────────────
async function fetchSitemapUrls(siteUrl) {
  var root = getRootUrl(siteUrl);
  var urls = [];

  // Tenta robots.txt para achar sitemap
  var sitemapUrl = root + '/sitemap.xml';
  try {
    var rr = await fetchWithTimeout(root + '/robots.txt', 8000);
    if (rr.ok) {
      var rtxt = await rr.text();
      var sm = rtxt.match(/Sitemap:\s*(.+)/i);
      if (sm) sitemapUrl = sm[1].trim();
    }
  } catch(e) {}

  // Busca sitemap
  try {
    var sr = await fetchWithTimeout(sitemapUrl, 10000);
    if (!sr.ok) throw new Error('sitemap nao encontrado');
    var xml = await sr.text();

    // Extrai URLs do sitemap (suporta sitemap index e sitemap regular)
    var locMatches = xml.match(/<loc>([^<]+)<\/loc>/gi) || [];
    var sitemapIndexMatches = xml.match(/<sitemap>/gi) || [];

    if (sitemapIndexMatches.length > 0 && locMatches.length > 0) {
      // É um sitemap index — pega o primeiro sub-sitemap
      var firstChildUrl = locMatches[0].replace(/<\/?loc>/gi, '').trim();
      try {
        var cr = await fetchWithTimeout(firstChildUrl, 10000);
        if (cr.ok) {
          var cxml = await cr.text();
          locMatches = cxml.match(/<loc>([^<]+)<\/loc>/gi) || [];
        }
      } catch(e) {}
    }

    urls = locMatches
      .map(function(l) { return l.replace(/<\/?loc>/gi, '').trim(); })
      .filter(function(u) { return u.startsWith('http') && !u.match(/\.(xml|pdf|jpg|jpeg|png|gif|svg|css|js)$/i); });

  } catch(e) {
    // Fallback: usa só a URL fornecida
    urls = [siteUrl];
  }

  // Limita a 60 URLs max, priorizando diversidade
  if (urls.length > 60) {
    var sampled = [urls[0]]; // homepage sempre
    var step = Math.floor(urls.length / 59);
    for (var i = step; i < urls.length && sampled.length < 60; i += step) {
      sampled.push(urls[i]);
    }
    urls = sampled;
  }

  return urls;
}

// ── AUDIT DE UMA PÁGINA ───────────────────────────────
async function auditPage(url) {
  var result = { url: url, status: null, title: null, description: null, h1: null, canonical: null, hasOgImage: false, hasJsonLd: false, wordCount: 0, error: null };
  try {
    var r = await fetchWithTimeout(url, 10000);
    result.status = r.status;
    if (!r.ok) { result.error = 'HTTP ' + r.status; return result; }
    var html = await r.text();

    var get = function(p) { var m = html.match(p); return m ? (m[1]||'').trim() : null; };
    result.title       = get(/<title[^>]*>([^<]+)<\/title>/i);
    result.description = get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,})/i) || get(/<meta[^>]+content=["']([^"']{10,})["'][^>]+name=["']description["']/i);
    result.h1          = get(/<h1[^>]*>([^<]+)<\/h1>/i);
    result.canonical   = get(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
    result.hasOgImage  = /<meta[^>]+property=["']og:image["']/i.test(html);
    result.hasJsonLd   = /<script[^>]+type=["']application\/ld\+json["']/i.test(html);
    result.titleLen    = result.title ? result.title.length : 0;
    result.descLen     = result.description ? result.description.length : 0;
    var bodyText = html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    result.wordCount   = bodyText.split(' ').filter(function(w){ return w.length>2; }).length;

    // Score simples por página
    var pts = 0, tot = 0;
    tot++; if (result.title && result.titleLen >= 30 && result.titleLen <= 65) pts++;
    tot++; if (result.description && result.descLen >= 80 && result.descLen <= 165) pts++;
    tot++; if (result.h1) pts++;
    tot++; if (result.canonical) pts++;
    tot++; if (result.hasOgImage) pts++;
    tot++; if (result.hasJsonLd) pts++;
    result.score = Math.round((pts / tot) * 100);

  } catch(e) {
    result.error = e.message || 'timeout';
    result.score = 0;
  }
  return result;
}

// ── AI SUMMARY ────────────────────────────────────────
async function callAISummary(siteUrl, auditedPages, totalUrls) {
  var apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY nao configurada.');

  var ok   = auditedPages.filter(function(p){ return !p.error; });
  var errs = auditedPages.filter(function(p){ return p.error; });

  var noTitle   = ok.filter(function(p){ return !p.title; }).length;
  var noDesc    = ok.filter(function(p){ return !p.description; }).length;
  var noH1      = ok.filter(function(p){ return !p.h1; }).length;
  var noOg      = ok.filter(function(p){ return !p.hasOgImage; }).length;
  var noSchema  = ok.filter(function(p){ return !p.hasJsonLd; }).length;
  var noCanon   = ok.filter(function(p){ return !p.canonical; }).length;
  var avgScore  = ok.length ? Math.round(ok.reduce(function(a,p){ return a+p.score; },0)/ok.length) : 0;

  var worstPages = ok.sort(function(a,b){ return a.score-b.score; }).slice(0,5).map(function(p){
    return p.url + ' (score: ' + p.score + ')';
  }).join(', ');

  var prompt = 'Voce e um consultor senior de SEO e GEO. Analise os dados de auditoria completa de um site e gere um relatorio estrategico em portugues do Brasil.\n\n'
    + 'SITE: ' + siteUrl + '\n'
    + 'Total de URLs no sitemap: ' + totalUrls + '\n'
    + 'URLs auditadas: ' + auditedPages.length + '\n'
    + 'URLs com erro de acesso: ' + errs.length + '\n'
    + 'Score medio do site: ' + avgScore + '/100\n\n'
    + 'PROBLEMAS ENCONTRADOS EM ESCALA:\n'
    + 'Paginas sem title: ' + noTitle + '/' + ok.length + '\n'
    + 'Paginas sem meta description: ' + noDesc + '/' + ok.length + '\n'
    + 'Paginas sem H1: ' + noH1 + '/' + ok.length + '\n'
    + 'Paginas sem og:image: ' + noOg + '/' + ok.length + '\n'
    + 'Paginas sem JSON-LD: ' + noSchema + '/' + ok.length + '\n'
    + 'Paginas sem canonical: ' + noCanon + '/' + ok.length + '\n\n'
    + 'PAGINAS COM PIOR SCORE: ' + worstPages + '\n\n'
    + 'IMPORTANTE: Analise APENAS os dados fornecidos. Seja especifico. Priorize problemas em escala (que afetam muitas paginas). Nao generalize.\n\n'
    + 'Retorne APENAS JSON valido:\n'
    + '{"segmento":"string","resumo_executivo":"string","nivel_seo":"Critico|Regular|Bom|Excelente","score_estimado":' + avgScore + ','
    + '"metricas":{"titulo":{"status":"ok|alerta|critico","texto":"string"},"description":{"status":"ok|alerta|critico","texto":"string"},"headings":{"status":"ok|alerta|critico","texto":"string"},"conteudo":{"status":"ok|alerta|critico","texto":"string"},"schema":{"status":"ok|alerta|critico","texto":"string"},"open_graph":{"status":"ok|alerta|critico","texto":"string"},"tecnico":{"status":"ok|alerta|critico","texto":"string"},"geo_ia":{"status":"ok|alerta|critico","texto":"string"}},'
    + '"acoes":[{"numero":1,"prioridade":"Critico|Alto|Medio","categoria":"string","titulo":"string","problema":"string","recomendacao":"string","impacto":"string","esforco":"Baixo|Medio|Alto","prazo":"string"}],'
    + '"oportunidades_keywords":[{"keyword":"string","intencao":"Informacional|Comercial|Transacional|BOFU","potencial":"Alto|Medio|Baixo","pagina_sugerida":"/url/"}],'
    + '"schema_recomendados":[{"tipo":"string","pagina":"string","impacto":"string","esforco":"Baixo|Medio"}],'
    + '"concorrentes_organicos":[{"nome":"string","url":"string","angulo":"string"}],'
    + '"proximo_passo_imediato":"string"}\n\n'
    + 'Gere 4 a 6 acoes, 6 a 10 keywords, 3 a 6 schemas, 3 a 5 concorrentes.';

  var endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  var response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4000,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 }
      }
    })
  });

  if (!response.ok) throw new Error('Erro Gemini: ' + (await response.text()).substring(0,200));
  var data = await response.json();
  var parts = (data.candidates&&data.candidates[0]&&data.candidates[0].content&&data.candidates[0].content.parts)||[];
  var text = '';
  for (var i=0;i<parts.length;i++) { if(parts[i].text&&!parts[i].thought) text+=parts[i].text; }
  text = text.trim();

  // Remove markdown wrapper se presente
  var md = text.match(/```json\s*([\s\S]*?)```/);
  if (md) text = md[1].trim();
  var start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start===-1||end===-1) throw new Error('JSON invalido do Gemini');
  var json = text.substring(start,end+1);

  // Repara chars invalidos
  var fixed='',inStr=false,esc=false;
  for (var j=0;j<json.length;j++) {
    var ch=json[j];
    if(esc){fixed+=ch;esc=false;continue;}
    if(ch==='\\'){fixed+=ch;esc=true;continue;}
    if(ch==='"'){inStr=!inStr;fixed+=ch;continue;}
    if(inStr&&(ch==='\n'||ch==='\r'||ch==='\t')){fixed+=' ';continue;}
    if(inStr&&ch.charCodeAt(0)<32){continue;}
    fixed+=ch;
  }
  return JSON.parse(fixed);
}

// ── HANDLER ───────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo nao permitido' });

  var body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  var url    = body.url;
  var offset = parseInt(body.offset) || 0;
  var jobId  = body.jobId || generateId();
  var BATCH  = 8;

  if (!url) return res.status(400).json({ error: 'URL nao fornecida' });
  var normalizedUrl = url.trim();
  if (!normalizedUrl.startsWith('http')) normalizedUrl = 'https://' + normalizedUrl;

  try {
    var allUrls;

    if (offset === 0) {
      // Primeiro lote: descobre URLs do sitemap
      allUrls = await fetchSitemapUrls(normalizedUrl);
      // Salva lista no KV para os próximos lotes
      await kv.set('job:' + jobId + ':urls', JSON.stringify(allUrls), { ex: 3600 });
      await kv.set('job:' + jobId + ':results', JSON.stringify([]), { ex: 3600 });
    } else {
      // Lotes seguintes: recupera lista salva
      var storedUrls = await kv.get('job:' + jobId + ':urls');
      allUrls = storedUrls ? JSON.parse(storedUrls) : [normalizedUrl];
    }

    var total  = allUrls.length;
    var batch  = allUrls.slice(offset, offset + BATCH);
    var isDone = (offset + BATCH) >= total;

    // Audita lote atual em paralelo
    var batchResults = await Promise.all(batch.map(auditPage));

    // Acumula resultados no KV
    var storedResults = await kv.get('job:' + jobId + ':results');
    var allResults = storedResults ? JSON.parse(storedResults) : [];
    allResults = allResults.concat(batchResults);
    await kv.set('job:' + jobId + ':results', JSON.stringify(allResults), { ex: 3600 });

    var nextOffset = offset + BATCH;
    var progress   = Math.min(Math.round((nextOffset / total) * 100), 99);

    // Último lote: gera análise da IA e salva relatório final
    if (isDone) {
      var aiReport = await callAISummary(normalizedUrl, allResults, total);
      var now = new Date();
      aiReport.url      = normalizedUrl;
      aiReport.geradoEm = now.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'})
        + ' as ' + now.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
      aiReport.modo     = 'completo';
      aiReport.totalUrls     = total;
      aiReport.auditedPages  = allResults;
      aiReport.dadosTecnicos = {
        url: normalizedUrl, https: normalizedUrl.startsWith('https://'),
        wordCount: 0, imgs: 0, imgsNoAlt: 0, hasJsonLd: false
      };

      var reportId = generateId();
      try { await kv.set('report:' + reportId, aiReport, { ex: 60*60*24*90 }); } catch(e) {}

      // Limpa job do KV
      try { await kv.del('job:' + jobId + ':urls'); await kv.del('job:' + jobId + ':results'); } catch(e) {}

      aiReport.reportId = reportId;

      // Envia para Make
      try {
        await fetch('https://hook.us2.make.com/6lgcyv51fg2wn66t8b5iiqgsbc875qq3', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            data: aiReport.geradoEm, url: normalizedUrl,
            score: aiReport.score_estimado, nivel: aiReport.nivel_seo,
            segmento: aiReport.segmento,
            link: 'https://criamente.vercel.app/?report=' + reportId
          })
        });
      } catch(e) {}

      return res.status(200).json({ success: true, done: true, report: aiReport });
    }

    // Lote intermediário: retorna progresso
    return res.status(200).json({
      success: true,
      done: false,
      jobId: jobId,
      offset: nextOffset,
      total: total,
      progress: progress,
      audited: allResults.length,
      batchResults: batchResults
    });

  } catch(err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
