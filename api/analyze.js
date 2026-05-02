async function fetchHTML(url) {
  var response = await fetch(url, {
    signal: AbortSignal.timeout(25000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; CriamenteSEOBot/1.0)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache'
    }
  });
  if (!response.ok) throw new Error('Site retornou HTTP ' + response.status);
  var text = await response.text();
  if (text.length < 100) throw new Error('Pagina retornou conteudo vazio.');
  return text;
}

function extractSEO(html, url) {
  var get = function(p) { var m = html.match(p); return m ? (m[1] || '').trim() : null; };
  var getAll = function(p) { return html.match(new RegExp(p.source, 'gi')) || []; };
  var title = get(/<title[^>]*>([^<]+)<\/title>/i);
  var description =
    get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,})/i) ||
    get(/<meta[^>]+content=["']([^"']{10,})["'][^>]+name=["']description["']/i);
  var h1s = getAll(/<h1[^>]*>([^<]+)<\/h1>/i).map(function(h) { return h.replace(/<[^>]+>/g,'').trim(); }).filter(Boolean);
  var h2s = getAll(/<h2[^>]*>[^<]+<\/h2>/i).map(function(h) { return h.replace(/<[^>]+>/g,'').trim(); }).filter(Boolean);
  var canonical = get(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  var robots    = get(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)["']/i);
  var viewport  = /<meta[^>]+name=["']viewport["']/i.test(html);
  var lang      = get(/<html[^>]+lang=["']([^"']+)["']/i);
  var ogTitle   = get(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  var ogDesc    = get(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  var ogImage   = get(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  var twitterCard = get(/<meta[^>]+name=["']twitter:card["'][^>]+content=["']([^"']+)["']/i);
  var hasJsonLd = /<script[^>]+type=["']application\/ld\+json["']/i.test(html);
  var jsonLdTypes = [];
  (html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || []).forEach(function(s) {
    try {
      var d = JSON.parse(s.replace(/<[^>]+>/g,''));
      if (d['@type']) jsonLdTypes.push(d['@type']);
      if (d['@graph']) d['@graph'].forEach(function(g) { if (g['@type']) jsonLdTypes.push(g['@type']); });
    } catch(e) {}
  });
  var imgs = html.match(/<img[^>]*>/gi) || [];
  var imgsNoAlt = imgs.filter(function(i) { return !(/alt=["'][^"']+["']/i.test(i)); }).length;
  var host = ''; try { host = new URL(url).hostname; } catch(e) {}
  var allLinks = html.match(/<a[^>]+href=["']([^"']+)["']/gi) || [];
  var internalLinks = allLinks.filter(function(a) {
    try { var m = a.match(/href=["']([^"']+)["']/i); return new URL(m ? m[1] : '', url).hostname === host; } catch(e) { return false; }
  }).length;
  var bodyText = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  var wordCount = bodyText.split(' ').filter(function(w) { return w.length > 2; }).length;
  return {
    url: url, https: url.startsWith('https://'),
    title: title, titleLen: title ? title.length : 0,
    description: description, descLen: description ? description.length : 0,
    h1s: h1s.slice(0,5), h2s: h2s.slice(0,10), h2Count: h2s.length,
    canonical: canonical, robots: robots, viewport: viewport, lang: lang,
    ogTitle: ogTitle, ogDesc: ogDesc, ogImage: ogImage, twitterCard: twitterCard,
    hasJsonLd: hasJsonLd, jsonLdTypes: jsonLdTypes,
    imgs: imgs.length, imgsNoAlt: imgsNoAlt, internalLinks: internalLinks, wordCount: wordCount,
    bodyTextSample: bodyText.substring(0, 3000)
  };
}

function repairAndParseJSON(text) {
  var clean = text.trim();

  // Remove wrapper markdown ```json ... ``` ou ``` ... ```
  var mdMatch = clean.match(/```json\s*([\s\S]*?)```/);
  if (mdMatch) { clean = mdMatch[1].trim(); }
  else {
    var mdMatch2 = clean.match(/```\s*([\s\S]*?)```/);
    if (mdMatch2) { clean = mdMatch2[1].trim(); }
  }

  var start = clean.indexOf('{');
  var end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Nenhum JSON encontrado. Resposta: ' + text.substring(0, 300));
  var json = clean.substring(start, end + 1);

  // Tenta direto primeiro
  try { return JSON.parse(json); } catch(e) {}

  // Repara caracteres invalidos dentro de strings
  var fixed = '';
  var inString = false;
  var escape = false;
  for (var i = 0; i < json.length; i++) {
    var ch = json[i];
    if (escape) { fixed += ch; escape = false; continue; }
    if (ch === '\\') { fixed += ch; escape = true; continue; }
    if (ch === '"') { inString = !inString; fixed += ch; continue; }
    if (inString) {
      if (ch === '\n' || ch === '\r') { fixed += ' '; continue; }
      if (ch === '\t') { fixed += ' '; continue; }
    }
    fixed += ch;
  }

  try { return JSON.parse(fixed); } catch(e2) {
    throw new Error('JSON invalido: ' + e2.message + ' | Trecho: ' + fixed.substring(2880, 2960));
  }
}

async function callAI(seoData) {
  var apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY nao configurada nas variaveis do Vercel.');

  var endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;

  var prompt = 'Voce e um consultor senior de SEO e GEO. Analise os dados do site e gere um relatorio estrategico em portugues do Brasil.\n\n'
    + 'DADOS DO SITE:\n'
    + 'URL: ' + seoData.url + '\n'
    + 'HTTPS: ' + seoData.https + '\n'
    + 'Title: ' + (seoData.title || 'AUSENTE') + ' (' + seoData.titleLen + ' chars)\n'
    + 'Meta Description: ' + (seoData.description || 'AUSENTE') + ' (' + seoData.descLen + ' chars)\n'
    + 'H1s: ' + (seoData.h1s.join(' | ') || 'NENHUM') + '\n'
    + 'H2s: ' + (seoData.h2s.join(' | ') || 'NENHUM') + '\n'
    + 'Canonical: ' + (seoData.canonical || 'AUSENTE') + '\n'
    + 'Robots: ' + (seoData.robots || 'nao definido') + '\n'
    + 'Viewport: ' + (seoData.viewport ? 'sim' : 'nao') + '\n'
    + 'Lang: ' + (seoData.lang || 'nao definido') + '\n'
    + 'Open Graph: title=' + (seoData.ogTitle ? 'sim' : 'nao') + ', desc=' + (seoData.ogDesc ? 'sim' : 'nao') + ', img=' + (seoData.ogImage ? 'sim' : 'nao') + '\n'
    + 'Twitter Card: ' + (seoData.twitterCard || 'ausente') + '\n'
    + 'JSON-LD: ' + (seoData.hasJsonLd ? 'sim, tipos: ' + seoData.jsonLdTypes.join(', ') : 'AUSENTE') + '\n'
    + 'Imagens: ' + seoData.imgs + ' total, ' + seoData.imgsNoAlt + ' sem alt\n'
    + 'Links internos: ' + seoData.internalLinks + '\n'
    + 'Palavras estimadas: ' + seoData.wordCount + '\n'
    + 'Conteudo:\n' + seoData.bodyTextSample + '\n\n'
    + 'IMPORTANTE: Retorne APENAS JSON valido. Todos os valores de string devem estar em uma unica linha, sem quebras de linha dentro das strings. Use ponto e virgula ou virgula para separar frases dentro das strings, nunca caractere de nova linha.\n\n'
    + 'Estrutura obrigatoria:\n'
    + '{"segmento":"string","resumo_executivo":"string sem quebra de linha","nivel_seo":"Critico|Regular|Bom|Excelente","score_estimado":0,'
    + '"metricas":{"titulo":{"status":"ok|alerta|critico","texto":"string"},"description":{"status":"ok|alerta|critico","texto":"string"},"headings":{"status":"ok|alerta|critico","texto":"string"},"conteudo":{"status":"ok|alerta|critico","texto":"string"},"schema":{"status":"ok|alerta|critico","texto":"string"},"open_graph":{"status":"ok|alerta|critico","texto":"string"},"tecnico":{"status":"ok|alerta|critico","texto":"string"},"geo_ia":{"status":"ok|alerta|critico","texto":"string"}},'
    + '"acoes":[{"numero":1,"prioridade":"Critico|Alto|Medio","categoria":"string","titulo":"string","problema":"string sem quebra de linha","recomendacao":"string sem quebra de linha","impacto":"string","esforco":"Baixo|Medio|Alto","prazo":"string"}],'
    + '"oportunidades_keywords":[{"keyword":"string","intencao":"Informacional|Comercial|Transacional|BOFU","potencial":"Alto|Medio|Baixo","pagina_sugerida":"/url/"}],'
    + '"schema_recomendados":[{"tipo":"string","pagina":"string","impacto":"string","esforco":"Baixo|Medio"}],'
    + '"concorrentes_organicos":[{"nome":"string","url":"string","angulo":"string"}],'
    + '"proximo_passo_imediato":"string"}\n\n'
    + 'Gere 4 a 6 acoes, 6 a 10 keywords, 3 a 6 schemas, 3 a 5 concorrentes.';

  var response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4000
      }
    })
  });

  if (!response.ok) {
    var errText = await response.text();
    throw new Error('Erro Gemini API: ' + errText.substring(0, 400));
  }

  var data = await response.json();
  var parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  var rawText = '';
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].text && !parts[i].thought) rawText += parts[i].text;
  }

  return repairAndParseJSON(rawText.trim());
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo nao permitido' });

  var body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  var url = body.url;
  if (!url) return res.status(400).json({ error: 'URL nao fornecida' });

  var normalizedUrl = url.trim();
  if (!normalizedUrl.startsWith('http')) normalizedUrl = 'https://' + normalizedUrl;

  try {
    var html    = await fetchHTML(normalizedUrl);
    var seoData = extractSEO(html, normalizedUrl);
    var report  = await callAI(seoData);
    report.url = normalizedUrl;
    report.geradoEm = new Date().toLocaleDateString('pt-BR', {day:'2-digit',month:'2-digit',year:'numeric'})
      + ' as ' + new Date().toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'});
    report.dadosTecnicos = seoData;
    return res.status(200).json({ success: true, report: report });
  } catch(err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
